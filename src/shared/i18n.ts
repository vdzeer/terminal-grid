import type { Language } from './protocol';

// Flat dictionaries, one per language. `{0}` style placeholders, no plural
// forms: counts are written as "Terminals: 3".
const en = {
  newTerminal: 'New terminal',
  newTerminalHint: 'New terminal ({0}). Drag it onto a terminal to place it there',
  arrange: 'Arrange as grid',
  placeholder: 'Terminal Grid is open in an editor tab.',
  mirrorHint: 'Terminal from the Terminal tab, shown at its real size. Resize it there.',
  hideMirror: 'Hide from the grid (the terminal keeps running)',
  mirrorsOff:
    'Terminals opened outside the grid are not shown in it yet. To show them, add "enable-proposed-api": ["vdzeer.terminal-grid"] to argv.json, then quit {0} and open it again.',
  openArgv: 'Open argv.json',
  moveToPanel: 'Move it here',
  splitRight: 'Split right ({0})',
  splitDown: 'Split down ({0})',
  maximize: 'Maximize ({0})',
  restore: 'Restore size ({0})',
  close: 'Close terminal',
  renameHint: 'Double-click to rename',
  find: 'Find',
  findPrevious: 'Previous match (Shift+Enter)',
  findNext: 'Next match (Enter)',
  findClose: 'Close (Escape)',
  noResults: 'No results',
  resultCount: '{0} of {1}',
  exited: 'Process exited with code {0}',
  restart: 'Restart',
  emptyTitle: 'No terminals yet',
  emptyHint: 'Create one, then drag tiles by their header to rearrange them.',
  dropSwap: 'Swap',
  dropHere: 'Place here',
  historyRestored: 'History restored',
  terminalsCount: 'Terminals: {0}',
  panelTitle: 'Terminals',
  confirmClose: '“{0}” is still running in this terminal. Close it?',
  confirmCloseButton: 'Close',
  confirmKillAll: 'Close all grid terminals? Running processes will be stopped.',
  confirmKillAllMirrors:
    'Close all grid terminals? Processes running in them will be stopped. Terminals from the Terminal tab are only hidden from the grid and keep running.',
  killAllButton: 'Close all',
  ptyMissing:
    'Terminal Grid cannot start terminals: node-pty, which {0} normally ships, was not found or did not load. Please report it at github.com/vdzeer/terminal-grid/issues with the editor name and version. Details: {1}',
  askDefaultProfile:
    'Make Terminal Grid the default terminal profile? New terminals from the Terminal tab will then also show in the grid. You can do it later with "Terminal Grid: Make Default Terminal Profile".',
  makeDefault: 'Make default',
  notNow: 'Not now',
  defaultProfileDone: 'Terminal Grid is now the default terminal profile. To change it back, run "Terminal: Select Default Profile".',
  statusTooltip: 'Terminal Grid. Terminals: {0}',
  fileNotFound: 'File not found: {0}',
  spawnFailed: 'Could not start the shell: {0}',
  newAgent: 'New agent',
  newAgentHint: 'New terminal that starts the AI agent ({0})',
  statusWorking: 'Working',
  statusWaiting: 'Waiting for you',
  statusWaitingCount: 'Waiting for you: {0}',
  dropPath: 'Drop to insert the path',
  dropHoldShift: 'Hold Shift to drop here',
} as const;

export type MessageKey = keyof typeof en;

const uk: Record<MessageKey, string> = {
  newTerminal: 'Новий термінал',
  newTerminalHint: 'Новий термінал ({0}). Перетягніть кнопку на термінал, щоб поставити новий поруч',
  arrange: 'Розкласти сіткою',
  placeholder: 'Сітка терміналів відкрита у вкладці редактора.',
  mirrorHint: 'Термінал із вкладки «Термінал» у справжньому розмірі. Розмір змінюється там.',
  hideMirror: 'Сховати із сітки (термінал працює далі)',
  mirrorsOff:
    'Термінали, відкриті поза сіткою, поки що в ній не показуються. Щоб вони зʼявилися, додайте "enable-proposed-api": ["vdzeer.terminal-grid"] в argv.json, потім закрийте {0} повністю і відкрийте знову.',
  openArgv: 'Відкрити argv.json',
  moveToPanel: 'Перенести сюди',
  splitRight: 'Поділити праворуч ({0})',
  splitDown: 'Поділити вниз ({0})',
  maximize: 'Розгорнути ({0})',
  restore: 'Повернути розмір ({0})',
  close: 'Закрити термінал',
  renameHint: 'Двічі клацніть, щоб перейменувати',
  find: 'Знайти',
  findPrevious: 'Попередній збіг (Shift+Enter)',
  findNext: 'Наступний збіг (Enter)',
  findClose: 'Закрити (Escape)',
  noResults: 'Немає збігів',
  resultCount: '{0} з {1}',
  exited: 'Процес завершився з кодом {0}',
  restart: 'Перезапустити',
  emptyTitle: 'Терміналів ще немає',
  emptyHint: 'Створіть перший, а потім перетягуйте плитки за заголовок, щоб змінити розкладку.',
  dropSwap: 'Поміняти місцями',
  dropHere: 'Поставити сюди',
  historyRestored: 'Історію відновлено',
  terminalsCount: 'Терміналів: {0}',
  panelTitle: 'Термінали',
  confirmClose: 'У терміналі ще працює «{0}». Закрити його?',
  confirmCloseButton: 'Закрити',
  confirmKillAll: 'Закрити всі термінали сітки? Запущені процеси буде зупинено.',
  confirmKillAllMirrors:
    'Закрити всі термінали сітки? Запущені в них процеси буде зупинено. Термінали з вкладки «Термінал» лише зникнуть із сітки й працюватимуть далі.',
  killAllButton: 'Закрити всі',
  ptyMissing:
    'Terminal Grid не може запускати термінали: node-pty, який зазвичай постачається з {0}, не знайдено або не вдалося завантажити. Повідомте про це на github.com/vdzeer/terminal-grid/issues, указавши назву і версію редактора. Подробиці: {1}',
  askDefaultProfile:
    'Зробити Terminal Grid профілем термінала за замовчуванням? Тоді нові термінали з вкладки «Термінал» теж будуть у сітці. Це можна зробити й пізніше командою «Terminal Grid: Зробити профілем термінала за замовчуванням».',
  makeDefault: 'Зробити',
  notNow: 'Не зараз',
  defaultProfileDone: 'Terminal Grid тепер профіль термінала за замовчуванням. Щоб змінити це, виконайте «Terminal: Select Default Profile».',
  statusTooltip: 'Terminal Grid. Терміналів: {0}',
  fileNotFound: 'Файл не знайдено: {0}',
  spawnFailed: 'Не вдалося запустити оболонку: {0}',
  newAgent: 'Новий агент',
  newAgentHint: 'Новий термінал, що запускає ШІ-агента ({0})',
  statusWorking: 'Працює',
  statusWaiting: 'Чекає на вас',
  statusWaitingCount: 'Чекають на вас: {0}',
  dropPath: 'Відпустіть, щоб вставити шлях',
  dropHoldShift: 'Утримуйте Shift, щоб кинути сюди',
};

export const dictionaries: Record<Language, Record<MessageKey, string>> = { en, uk };

export function languageFor(locale: string | undefined): Language {
  return locale?.toLowerCase().startsWith('uk') ? 'uk' : 'en';
}

export function translator(language: Language) {
  const dict = dictionaries[language];
  return (key: MessageKey, ...args: (string | number)[]): string =>
    dict[key].replace(/\{(\d+)\}/g, (match, i: string) => {
      const value = args[Number(i)];
      return value === undefined ? match : String(value);
    });
}

export type Translate = ReturnType<typeof translator>;
