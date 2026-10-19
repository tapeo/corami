import { progressLine } from '@/cli/commands/setup-steps.ts';
import type { OutputOptions } from '@/cli/output.ts';

export type ProgressUnit = 'bytes' | 'files' | 'objects';

export interface BarOptions {
  step: string;
  activity: string;
  done: number;
  total: number | undefined;
  unit: ProgressUnit;
  elapsedMs: number;
  width?: number | undefined;
}

const BAR_CELLS = 16;
const MIN_BAR_CELLS = 5;

export function formatBytes(bytes: number): string {
  const value = Math.max(0, bytes);

  if (value < 1000) {
    return `${Math.round(value)} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1000;
  let unit = 0;

  while (size >= 1000 && unit < units.length - 1) {
    size /= 1000;
    unit += 1;
  }

  const shown = size >= 100 ? String(Math.round(size)) : size.toFixed(1);

  return `${shown} ${units[unit] ?? 'TB'}`;
}

function amountText(value: number, unit: ProgressUnit): string {
  return unit === 'bytes' ? formatBytes(value) : String(Math.max(0, Math.round(value)));
}

function bar(cells: number, percent: number): string {
  const filled = Math.min(cells, Math.max(0, Math.floor((cells * percent) / 100)));

  return `[${'█'.repeat(filled)}${'░'.repeat(cells - filled)}]`;
}

export function barLine(options: BarOptions): string {
  const width = options.width === undefined || options.width <= 0 ? 80 : options.width;
  const total = options.total ?? 0;

  if (total <= 0) {
    return progressLine(options.step, options.activity, options.elapsedMs, width);
  }

  const prefix = `${'running'.padEnd(8)} ${options.step.padEnd(15)} `;
  const seconds = Math.floor(options.elapsedMs / 1000);
  const percent = Math.min(99, Math.max(0, Math.floor((options.done / total) * 100)));
  const percentText = `${String(percent).padStart(3)}%`;
  const amount = `${amountText(options.done, options.unit)}/${amountText(total, options.unit)}`;
  const tail = `${percentText}  ${amount}  ${seconds}s`;
  const shortTail = `${percentText}  ${seconds}s`;
  const room = width - 1 - prefix.length;
  const withBar = (text: string): string | undefined => {
    const cells = Math.min(BAR_CELLS, room - text.length - 4);

    return cells < MIN_BAR_CELLS ? undefined : `${bar(cells, percent)}  ${text}`;
  };
  const candidates = [withBar(tail), withBar(shortTail), tail, shortTail, percentText].filter(
    (candidate): candidate is string => candidate !== undefined,
  );

  for (const candidate of candidates) {
    if (candidate.length <= room) {
      return `${prefix}${candidate}`;
    }
  }

  return `${prefix}${percentText}`.slice(0, width - 1);
}

export interface ProgressUpdate {
  done: number;
  total: number | undefined;
  unit?: ProgressUnit | undefined;
  activity?: string | undefined;
}

export interface ProgressReporter {
  readonly interactive: boolean;
  wait<T>(step: string, activity: string, work: () => Promise<T>): Promise<T>;
  count<T>(
    step: string,
    activity: string,
    unit: ProgressUnit,
    work: (update: (update: ProgressUpdate) => void) => Promise<T>,
  ): Promise<T>;
}

export function progressFor(output: OutputOptions): ProgressReporter {
  return output.json ? silentProgress : terminalProgress();
}

export const silentProgress: ProgressReporter = {
  interactive: false,

  async wait(_step, _activity, work) {
    return work();
  },

  async count(_step, _activity, _unit, work) {
    return work(() => {});
  },
};

const CLEAR_LINE = '\r\x1b[2K';
const REPAINT_MS = 100;

function terminalWidth(): number {
  const columns = process.stdout.columns;

  return columns === undefined || columns <= 0 ? 80 : columns;
}

export function terminalProgress(): ProgressReporter {
  let pending = false;
  let line = '';

  const paint = () => {
    if (line === '') {
      return;
    }

    process.stdout.write(`${CLEAR_LINE}${line}`);
    pending = true;
  };

  const clear = () => {
    if (pending) {
      process.stdout.write(CLEAR_LINE);
      pending = false;
    }
  };

  return {
    interactive: true,

    async wait(step, activity, work) {
      const started = Date.now();
      const show = () => {
        line = progressLine(step, activity, Date.now() - started, terminalWidth());
        paint();
      };

      show();
      const ticker = setInterval(show, 1000);

      try {
        return await work();
      } finally {
        clearInterval(ticker);
        clear();
        line = '';
      }
    },

    async count(step, activity, unit, work) {
      const started = Date.now();
      let done = 0;
      let total: number | undefined;
      let current = activity;
      let currentUnit = unit;
      let lastPaint = 0;

      const show = (force: boolean) => {
        const now = Date.now();

        if (!force && now - lastPaint < REPAINT_MS) {
          return;
        }

        lastPaint = now;
        line = barLine({
          step,
          activity: current,
          done,
          total,
          unit: currentUnit,
          elapsedMs: now - started,
          width: terminalWidth(),
        });
        paint();
      };

      show(true);
      const ticker = setInterval(() => show(true), 1000);

      try {
        return await work((update) => {
          done = update.done;
          total = update.total;
          currentUnit = update.unit ?? currentUnit;
          current = update.activity ?? current;
          show(false);
        });
      } finally {
        clearInterval(ticker);
        clear();
        line = '';
      }
    },
  };
}
