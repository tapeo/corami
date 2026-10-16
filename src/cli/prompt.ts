import { createInterface } from 'node:readline/promises';

import type { OutputOptions } from '@/cli/output.ts';
import { parseChoice, parseYesNo } from '@/core/setup-choices.ts';

export interface Choice<T> {
  label: string;
  value: T;
}

/** Questions asked in a terminal. Without one, commands take their flags only. */
export interface Prompter {
  say(line?: string): void;
  /**
   * A line that stays until the next one: what a step is doing right now. It
   * must fit the terminal width, or it cannot be erased.
   */
  progress(line: string): void;
  ask(question: string): Promise<string>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  choose<T>(question: string, choices: Choice<T>[], fallback?: number): Promise<T>;
}

/**
 * Questions are asked only to a person: a terminal on both stdin and stdout,
 * and no `--json`. Agents and scripts get the same behavior as before.
 */
export function canPrompt(output: OutputOptions): boolean {
  return !output.json && process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export function terminalPrompter(): Prompter {
  let pending = false;

  // The progress line is erased before anything else is written over it.
  const clear = () => {
    if (pending) {
      process.stdout.write('\r\x1b[2K');
      pending = false;
    }
  };

  return {
    say(line = '') {
      clear();
      process.stdout.write(`${line}\n`);
    },

    progress(line) {
      clear();
      process.stdout.write(line);
      pending = true;
    },

    ask(question) {
      clear();
      return readLine(`${question} `);
    },

    async confirm(question, fallback) {
      clear();
      const hint = fallback ? '[Y/n]' : '[y/N]';

      for (;;) {
        const answer = parseYesNo(await readLine(`${question} ${hint} `), fallback);

        if (answer !== undefined) {
          return answer;
        }

        process.stdout.write('Answer y or n.\n');
      }
    },

    async choose(question, choices, fallback = 0) {
      clear();
      process.stdout.write(`${question}\n`);

      for (const [index, choice] of choices.entries()) {
        process.stdout.write(`  ${index + 1}. ${choice.label}\n`);
      }

      for (;;) {
        const answer = await readLine(`Choice [${fallback + 1}]: `);
        const index = parseChoice(answer, choices.length, fallback);
        const picked = index === undefined ? undefined : choices[index];

        if (picked !== undefined) {
          return picked.value;
        }

        process.stdout.write(`Answer with a number from 1 to ${choices.length}.\n`);
      }
    },
  };
}

// One reader per question: between questions the setup runs installers that
// write to the same terminal.
async function readLine(prompt: string): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stdout });

  reader.on('SIGINT', () => stop(reader));

  try {
    return (await reader.question(prompt)).trim();
  } catch {
    // Ctrl+D closes the input: the person is leaving the setup.
    return stop(reader);
  } finally {
    reader.close();
  }
}

function stop(reader: { close(): void }): never {
  reader.close();
  process.stdout.write('\n');
  process.exit(130);
}
