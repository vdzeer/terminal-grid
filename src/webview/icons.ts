// 16px line icons drawn with currentColor, in the spirit of codicons.

const svg = (body: string) =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  plus: svg('<path d="M8 3.5v9M3.5 8h9"/>'),
  grid: svg('<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>'),
  splitRight: svg('<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M8 2.5v11"/>'),
  splitDown: svg('<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M2.5 8h11"/>'),
  maximize: svg('<path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9"/>'),
  restore: svg('<path d="M13 3 9.5 6.5M9.5 3.5v3h3M3 13l3.5-3.5M6.5 12.5v-3h-3"/>'),
  close: svg('<path d="m4.5 4.5 7 7m0-7-7 7"/>'),
  terminal: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="m4.5 6 2 2-2 2M8.5 10.5h3"/>'),
  panel: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 9.5h13"/>'),
  chevronDown: svg('<path d="m4.5 6.5 3.5 3.5 3.5-3.5"/>'),
  chevronUp: svg('<path d="m4.5 9.5 3.5-3.5 3.5 3.5"/>'),
  arrowUp: svg('<path d="M8 13V3.5M4 7.5l4-4 4 4"/>'),
  arrowDown: svg('<path d="M8 3v9.5M4 8.5l4 4 4-4"/>'),
  mirror: svg('<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/>'),
  restart: svg('<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3"/>'),
};

export type IconName = keyof typeof icons;
