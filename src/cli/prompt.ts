import { createInterface } from 'node:readline/promises';

import type { OutputOptions } from '@/cli/output.ts';
import { parseChoice, parseYesNo } from '@/core/setup-choices.ts';

export interface Choice<T> {
  label: string;
  value: T;
}

export interface Prompter {
  say(line?: string): void;
  progress(line: string): void;
  ask(question: string, initial?: string): Promise<string>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  choose<T>(
    question: string,
    choices: Choice<T>[],
    fallback?: number,
    signal?: AbortSignal,
  ): Promise<T>;
}

export function canPrompt(output: OutputOptions): boolean {
  return !output.json && process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export function terminalPrompter(): Prompter {
  let pending = false;

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

    ask(question, initial = '') {
      clear();
      return readLine(`${question} `, initial);
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

    async choose(question, choices, fallback = 0, signal) {
      clear();
      process.stdout.write(`${question}\n`);

      for (const [index, choice] of choices.entries()) {
        process.stdout.write(`  ${index + 1}. ${choice.label}\n`);
      }

      for (;;) {
        const answer = await readLine(`Choice [${fallback + 1}]: `, '', signal);
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

async function readLine(prompt: string, initial = '', signal?: AbortSignal): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stdout });

  reader.on('SIGINT', () => stop(reader));

  try {
    const answer =
      signal === undefined ? reader.question(prompt) : reader.question(prompt, { signal });

    if (initial !== '') {
      reader.write(initial);
    }

    const given = (await answer).trim();

    return given === '' ? initial : given;
  } catch (error) {
    if (signal?.aborted === true) {
      process.stdout.write('\n');
      throw error;
    }

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
