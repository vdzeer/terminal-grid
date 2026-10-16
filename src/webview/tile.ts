import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal, type ILink, type ITheme } from '@xterm/xterm';
import type { Translate } from '../shared/i18n';
import { matchShortcut, shortcutLabel, type Shortcut } from '../shared/keys';
import type { Edge } from '../shared/layout';
import { findFileLinks } from '../shared/links';
import type { TerminalInfo, ViewMessage, ViewSettings } from '../shared/protocol';
import { icons, type IconName } from './icons';
import { readSearchColors } from './theme';

export interface TileHost {
  readonly t: Translate;
  readonly isMac: boolean;
  post(message: ViewMessage): void;
  onTileFocus(id: string): void;
  beginTileDrag(id: string, event: PointerEvent, handle: HTMLElement): void;
  split(id: string, edge: Edge): void;
  toggleZoom(id: string): void;
  isZoomed(id: string): boolean;
  /** True while a splitter is dragged: fit on every frame instead of at the end. */
  isLiveResizing(): boolean;
  runShortcut(id: string, shortcut: Shortcut): void;
}

const ACK_BATCH = 20_000;
const RESIZE_DELAY_MS = 80;

function button(icon: IconName, title: string, className = 'icon-button'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.innerHTML = icons[icon];
  b.title = title;
  b.setAttribute('aria-label', title);
  return b;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export class Tile {
  readonly element: HTMLDivElement;
  readonly terminal: Terminal;
  private info: TerminalInfo;
  private readonly fit = new FitAddon();
  private readonly search = new SearchAddon({ highlightLimit: 2000 });
  private webgl: WebglAddon | undefined;
  private readonly header: HTMLDivElement;
  private readonly titleEl: HTMLSpanElement;
  private readonly cwdEl: HTMLSpanElement;
  private readonly zoomButton: HTMLButtonElement;
  private readonly body: HTMLDivElement;
  private readonly exitBar: HTMLDivElement;
  private readonly searchBar: HTMLDivElement;
  private readonly searchInput: HTMLInputElement;
  private readonly searchCount: HTMLSpanElement;
  private readonly tooltip: HTMLDivElement;
  private readonly resizeObserver: ResizeObserver;
  private unacked = 0;
  private ackTimer: number | undefined;
  private fitFrame: number | undefined;
  private fitTimer: number | undefined;
  private resizeTimer: number | undefined;
  private sentSize = '';
  private opened = false;
  private disposed = false;
  /** A mirror shows a Terminal-tab terminal at that terminal's size; its text scales instead of reflowing. */
  private readonly mirror: boolean;

  constructor(
    info: TerminalInfo,
    private settings: ViewSettings,
    theme: ITheme,
    private readonly host: TileHost,
    size?: { cols: number; rows: number },
  ) {
    this.info = info;
    this.mirror = info.kind === 'mirror';
    const { t, isMac } = host;

    this.element = document.createElement('div');
    this.element.className = 'tile';
    this.element.dataset.id = info.id;

    this.header = document.createElement('div');
    this.header.className = 'tile-header';
    const icon = document.createElement('span');
    icon.className = 'tile-icon';
    icon.innerHTML = icons.terminal;
    this.titleEl = document.createElement('span');
    this.titleEl.className = 'tile-title';
    this.titleEl.title = t('renameHint');
    this.cwdEl = document.createElement('span');
    this.cwdEl.className = 'tile-cwd';
    const actions = document.createElement('div');
    actions.className = 'tile-actions';
    const splitRight = button('splitRight', t('splitRight', shortcutLabel('splitRight', isMac)));
    const splitDown = button('splitDown', t('splitDown', shortcutLabel('splitDown', isMac)));
    this.zoomButton = button('maximize', t('maximize', shortcutLabel('zoom', isMac)));
    const close = button('close', this.mirror ? t('hideMirror') : t('close'));
    actions.append(splitRight, splitDown, this.zoomButton, close);
    this.header.append(icon, this.titleEl, this.cwdEl);
    if (this.mirror) {
      const badge = document.createElement('span');
      badge.className = 'tile-badge';
      badge.innerHTML = icons.mirror;
      badge.title = t('mirrorHint');
      this.header.append(badge);
    }
    this.header.append(actions);

    this.body = document.createElement('div');
    this.body.className = 'tile-body';

    this.searchBar = document.createElement('div');
    this.searchBar.className = 'tile-search';
    this.searchBar.hidden = true;
    this.searchInput = document.createElement('input');
    this.searchInput.type = 'text';
    this.searchInput.placeholder = t('find');
    this.searchInput.spellcheck = false;
    this.searchCount = document.createElement('span');
    this.searchCount.className = 'tile-search-count';
    const prev = button('arrowUp', t('findPrevious'));
    const next = button('arrowDown', t('findNext'));
    const closeSearch = button('close', t('findClose'));
    this.searchBar.append(this.searchInput, this.searchCount, prev, next, closeSearch);

    this.exitBar = document.createElement('div');
    this.exitBar.className = 'tile-exit';
    this.exitBar.hidden = true;

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'link-tooltip';
    this.tooltip.hidden = true;

    this.element.append(this.header, this.body, this.searchBar, this.exitBar, this.tooltip);

    this.terminal = new Terminal({
      ...this.terminalOptions(settings),
      cols: info.fixedSize?.cols ?? size?.cols ?? 80,
      rows: info.fixedSize?.rows ?? size?.rows ?? 24,
      theme,
      allowProposedApi: true,
      allowTransparency: false,
      // OSC 8 hyperlinks: the same modifier-click as plain URLs, and the host opens only http(s) and mailto.
      linkHandler: {
        activate: (event, uri) => {
          if (this.modifierHeld(event)) this.host.post({ type: 'openUrl', url: uri });
        },
        hover: (event) => this.showTooltip(event),
        leave: () => this.hideTooltip(),
      },
    });
    this.terminal.loadAddon(this.fit);
    this.terminal.loadAddon(this.search);
    this.terminal.loadAddon(new Unicode11Addon());
    this.terminal.unicode.activeVersion = '11';
    this.terminal.loadAddon(
      new WebLinksAddon(
        (event, uri) => {
          if (this.modifierHeld(event)) this.host.post({ type: 'openUrl', url: uri });
        },
        { hover: (event) => this.showTooltip(event), leave: () => this.hideTooltip() },
      ),
    );
    this.terminal.registerLinkProvider({ provideLinks: (y, callback) => callback(this.fileLinks(y)) });

    this.terminal.onData((data) => this.host.post({ type: 'input', id: this.info.id, data }));
    this.terminal.attachCustomKeyEventHandler((event) => this.onKey(event));

    // Header interactions.
    this.header.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest('button, input')) return;
      this.host.beginTileDrag(this.info.id, event, this.header);
    });
    this.header.addEventListener('click', (event) => {
      if (!(event.target as HTMLElement).closest('button, input')) this.focus();
    });
    this.header.addEventListener('dblclick', (event) => {
      if ((event.target as HTMLElement).closest('button')) return;
      if ((event.target as HTMLElement).closest('.tile-title')) this.startRename();
      else this.host.toggleZoom(this.info.id);
    });
    this.header.addEventListener('auxclick', (event) => {
      if (event.button === 1) this.host.post({ type: 'close', id: this.info.id });
    });
    splitRight.addEventListener('click', () => this.host.split(this.info.id, 'right'));
    splitDown.addEventListener('click', () => this.host.split(this.info.id, 'bottom'));
    this.zoomButton.addEventListener('click', () => this.host.toggleZoom(this.info.id));
    close.addEventListener('click', () => this.host.post({ type: 'close', id: this.info.id }));

    // Search.
    this.search.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (!this.searchInput.value) this.searchCount.textContent = '';
      else if (resultCount === 0) this.searchCount.textContent = t('noResults');
      else this.searchCount.textContent = t('resultCount', resultIndex + 1, resultCount);
    });
    this.searchInput.addEventListener('input', () => this.find('next', true));
    this.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        this.find(event.shiftKey ? 'previous' : 'next');
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.closeSearch();
      }
    });
    prev.addEventListener('click', () => this.find('previous'));
    next.addEventListener('click', () => this.find('next'));
    closeSearch.addEventListener('click', () => this.closeSearch());

    this.element.addEventListener('focusin', () => this.host.onTileFocus(this.info.id));
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.render();
  }

  get id(): string {
    return this.info.id;
  }

  get title(): string {
    return this.info.customTitle || this.info.process || 'shell';
  }

  /** Opens xterm once the tile is in the document and has a size. */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.terminal.open(this.body);
    this.loadRenderer();
    this.resizeObserver.observe(this.body);
    this.fitNow();
  }

  private loadRenderer(): void {
    if (!this.settings.gpu || this.webgl) return;
    try {
      const webgl = new WebglAddon();
      // Browsers cap live WebGL contexts; a lost one falls back to the DOM renderer.
      webgl.onContextLoss(() => {
        webgl.dispose();
        if (this.webgl === webgl) this.webgl = undefined;
      });
      this.terminal.loadAddon(webgl);
      this.webgl = webgl;
    } catch {
      this.webgl = undefined;
    }
  }

  private terminalOptions(s: ViewSettings) {
    return {
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      lineHeight: s.lineHeight,
      letterSpacing: s.letterSpacing,
      cursorStyle: s.cursorStyle,
      cursorBlink: s.cursorBlink,
      scrollback: s.scrollback,
      macOptionIsMeta: s.macOptionIsMeta,
      minimumContrastRatio: s.minimumContrastRatio,
      drawBoldTextInBrightColors: s.drawBoldTextInBrightColors,
      rescaleOverlappingGlyphs: true,
    };
  }

  applySettings(settings: ViewSettings): void {
    this.settings = settings;
    const options = this.terminalOptions(settings);
    Object.assign(this.terminal.options, this.mirror ? { ...options, fontSize: this.terminal.options.fontSize ?? options.fontSize } : options);
    if (!settings.gpu && this.webgl) {
      this.webgl.dispose();
      this.webgl = undefined;
    } else if (settings.gpu && this.opened) {
      this.loadRenderer();
    }
    this.fitNow();
  }

  applyTheme(theme: ITheme): void {
    this.terminal.options.theme = theme;
  }

  update(info: TerminalInfo): void {
    const resized = info.fixedSize?.cols !== this.info.fixedSize?.cols || info.fixedSize?.rows !== this.info.fixedSize?.rows;
    this.info = info;
    this.render();
    if (this.mirror && resized) this.fitNow();
  }

  private render(): void {
    const { t } = this.host;
    this.titleEl.textContent = this.title;
    this.cwdEl.textContent = this.info.cwd ? basename(this.info.cwd) : '';
    this.cwdEl.title = this.info.cwd;
    const exited = this.info.exitCode !== undefined;
    this.element.classList.toggle('exited', exited);
    this.exitBar.hidden = !exited;
    if (exited) {
      this.exitBar.replaceChildren();
      const label = document.createElement('span');
      label.textContent = t('exited', this.info.exitCode ?? '');
      const restart = document.createElement('button');
      restart.type = 'button';
      restart.className = 'text-button';
      restart.textContent = t('restart');
      restart.addEventListener('click', () => this.host.post({ type: 'restart', id: this.info.id }));
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'text-button';
      close.textContent = t('close');
      close.addEventListener('click', () => this.host.post({ type: 'close', id: this.info.id }));
      this.exitBar.append(label, restart, close);
    }
  }

  setFocused(focused: boolean): void {
    this.element.classList.toggle('focused', focused);
  }

  setZoomed(zoomed: boolean): void {
    const { t, isMac } = this.host;
    this.element.classList.toggle('zoomed', zoomed);
    this.zoomButton.innerHTML = zoomed ? icons.restore : icons.maximize;
    const title = zoomed ? t('restore', shortcutLabel('zoom', isMac)) : t('maximize', shortcutLabel('zoom', isMac));
    this.zoomButton.title = title;
    this.zoomButton.setAttribute('aria-label', title);
  }

  focus(): void {
    this.terminal.focus();
  }

  // ---- output ----

  write(data: string): void {
    this.terminal.write(data, () => this.acknowledge(data.length));
  }

  /** Paints a saved screen; not counted for flow control. */
  writeSnapshot(data: string): void {
    if (data) this.terminal.write(data);
  }

  private acknowledge(chars: number): void {
    this.unacked += chars;
    if (this.unacked >= ACK_BATCH) {
      this.flushAck();
      return;
    }
    this.ackTimer ??= window.setTimeout(() => this.flushAck(), 20);
  }

  private flushAck(): void {
    window.clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    if (this.unacked === 0 || this.disposed) return;
    this.host.post({ type: 'ack', id: this.info.id, chars: this.unacked });
    this.unacked = 0;
  }

  // ---- size ----

  /** During layout animations only the final size matters; while dragging a splitter, every frame does. */
  scheduleFit(): void {
    if (!this.opened || this.disposed) return;
    if (this.host.isLiveResizing()) {
      if (this.fitFrame === undefined) {
        this.fitFrame = requestAnimationFrame(() => {
          this.fitFrame = undefined;
          this.fitNow();
        });
      }
      return;
    }
    window.clearTimeout(this.fitTimer);
    this.fitTimer = window.setTimeout(() => this.fitNow(), 60);
  }

  fitNow(): void {
    if (!this.opened || this.disposed) return;
    if (this.mirror) {
      this.scaleToFit();
      return;
    }
    const dims = this.fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) || dims.cols < 2 || dims.rows < 1) return;
    if (dims.cols !== this.terminal.cols || dims.rows !== this.terminal.rows) this.terminal.resize(dims.cols, dims.rows);
    const size = `${this.terminal.cols}x${this.terminal.rows}`;
    if (size === this.sentSize) return;
    window.clearTimeout(this.resizeTimer);
    // Shells redraw their prompt on every resize; send only the size the tile settles on.
    this.resizeTimer = window.setTimeout(() => {
      this.sentSize = size;
      this.host.post({ type: 'resize', id: this.info.id, cols: this.terminal.cols, rows: this.terminal.rows });
    }, RESIZE_DELAY_MS);
  }

  /**
   * Mirrors keep the real terminal's columns and rows, so the font size is
   * chosen to fit them into the tile (never larger than the configured size).
   */
  private scaleToFit(pass = 0): void {
    const size = this.info.fixedSize;
    if (!size) return;
    if (this.terminal.cols !== size.cols || this.terminal.rows !== size.rows) this.terminal.resize(size.cols, size.rows);
    const screen = this.body.querySelector<HTMLElement>('.xterm-screen');
    const style = getComputedStyle(this.body);
    const availableWidth = this.body.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 12;
    const availableHeight = this.body.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    if (!screen || screen.offsetWidth === 0 || screen.offsetHeight === 0 || availableWidth <= 0 || availableHeight <= 0) return;
    const current = this.terminal.options.fontSize ?? this.settings.fontSize;
    const scale = Math.min(availableWidth / screen.offsetWidth, availableHeight / screen.offsetHeight);
    const next = Math.max(5, Math.min(this.settings.fontSize, Math.floor(current * scale * 2) / 2));
    if (next !== current) {
      this.terminal.options.fontSize = next;
      // Glyph metrics do not scale exactly; one more pass settles it.
      if (pass < 2) requestAnimationFrame(() => this.scaleToFit(pass + 1));
    }
  }

  // ---- keyboard ----

  private onKey(event: KeyboardEvent): boolean {
    // The editor's own terminals get Shift+Enter from a keybinding that only
    // works while they have focus, so the grid sends the same sequence itself.
    const shiftEnter = event.key === 'Enter' && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
    if (shiftEnter && this.settings.shiftEnter) {
      if (event.type === 'keydown') {
        event.preventDefault();
        event.stopPropagation();
        this.host.post({ type: 'input', id: this.info.id, data: this.settings.shiftEnter });
      }
      // Also swallow the keypress, or xterm would send a plain Enter after it.
      return false;
    }
    if (event.type !== 'keydown') return true;
    const shortcut = matchShortcut(event, this.host.isMac);
    if (!shortcut) return true;
    // Keep the editor from also acting on the keys (Cmd+K starts a chord there).
    event.preventDefault();
    event.stopPropagation();
    this.host.runShortcut(this.info.id, shortcut);
    return false;
  }

  clear(): void {
    this.terminal.clear();
  }

  // ---- search ----

  openSearch(): void {
    this.searchBar.hidden = false;
    const selection = this.terminal.getSelection();
    if (selection && !selection.includes('\n')) this.searchInput.value = selection;
    this.searchInput.focus();
    this.searchInput.select();
    if (this.searchInput.value) this.find('next', true);
  }

  private closeSearch(): void {
    this.searchBar.hidden = true;
    this.search.clearDecorations();
    this.searchCount.textContent = '';
    this.focus();
  }

  private find(direction: 'next' | 'previous', incremental = false): void {
    const term = this.searchInput.value;
    if (!term) {
      this.search.clearDecorations();
      this.searchCount.textContent = '';
      return;
    }
    const options = { incremental, decorations: readSearchColors() };
    if (direction === 'next') this.search.findNext(term, options);
    else this.search.findPrevious(term, options);
  }

  // ---- links ----

  private modifierHeld(event: MouseEvent): boolean {
    return this.host.isMac ? event.metaKey : event.ctrlKey;
  }

  private showTooltip(event: MouseEvent): void {
    const rect = this.element.getBoundingClientRect();
    this.tooltip.textContent = this.host.isMac ? '⌘ + click' : 'Ctrl + click';
    this.tooltip.style.left = `${Math.min(event.clientX - rect.left + 12, rect.width - 110)}px`;
    this.tooltip.style.top = `${Math.max(event.clientY - rect.top - 28, 30)}px`;
    this.tooltip.hidden = false;
  }

  private hideTooltip(): void {
    this.tooltip.hidden = true;
  }

  private fileLinks(y: number): ILink[] | undefined {
    const line = this.terminal.buffer.active.getLine(y - 1);
    if (!line) return undefined;
    // Build the text cell by cell so string positions map back to columns,
    // including wide characters.
    let text = '';
    const columnAt: number[] = [];
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      for (let i = 0; i < chars.length; i++) columnAt.push(x);
      text += chars;
    }
    const links = findFileLinks(text);
    if (links.length === 0) return undefined;
    return links.map((link) => {
      const startX = (columnAt[link.start] ?? 0) + 1;
      const endX = (columnAt[link.end - 1] ?? 0) + 1;
      return {
        range: { start: { x: startX, y }, end: { x: endX, y } },
        text: text.slice(link.start, link.end),
        decorations: { pointerCursor: true, underline: true },
        activate: (event: MouseEvent) => {
          if (!this.modifierHeld(event)) return;
          this.host.post({ type: 'openFile', id: this.info.id, path: link.path, line: link.line, column: link.column });
        },
        hover: (event: MouseEvent) => this.showTooltip(event),
        leave: () => this.hideTooltip(),
      };
    });
  }

  // ---- rename ----

  private startRename(): void {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tile-rename';
    input.value = this.title;
    input.spellcheck = false;
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      if (commit) {
        const value = input.value.trim();
        // Clearing the name, or typing the process name, goes back to the automatic title.
        this.host.post({ type: 'rename', id: this.info.id, title: value === this.info.process ? '' : value });
      }
      input.replaceWith(this.titleEl);
      this.focus();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== 'Escape') return;
      event.stopPropagation();
      finish(event.key === 'Enter');
    });
    input.addEventListener('blur', () => finish(true));
    this.titleEl.replaceWith(input);
    input.focus();
    input.select();
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.ackTimer);
    window.clearTimeout(this.fitTimer);
    window.clearTimeout(this.resizeTimer);
    if (this.fitFrame !== undefined) cancelAnimationFrame(this.fitFrame);
    this.resizeObserver.disconnect();
    this.terminal.dispose();
    this.element.remove();
  }
}
