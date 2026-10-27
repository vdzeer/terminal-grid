// Programs say what they are doing through the terminal title. AI coding
// agents put a spinner before it while they work and a fixed mark once they
// wait for the user: Claude Code shows "◐"/"◑" while busy and "✳" when idle,
// other command line tools often use braille spinner frames.

const WORKING = /^[◐-◓⠁-⣿]\s+/;
const IDLE = /^✳\s+/;

export interface ProgramTitle {
  /** The title without the status mark. */
  label: string;
  /** True while working, false when waiting, undefined when the title says nothing about it. */
  working: boolean | undefined;
}

export function readTitle(raw: string): ProgramTitle {
  const title = raw.trim();
  if (WORKING.test(title)) return { label: title.replace(WORKING, ''), working: true };
  if (IDLE.test(title)) return { label: title.replace(IDLE, ''), working: false };
  return { label: title, working: undefined };
}
