import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { paths } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { commandPath, fileExists, run } from '@/core/exec.ts';

export interface PinnedTool {
  name: string;
  version: string;
  asset: (platform: NodeJS.Platform, arch: string) => string;
  url: (asset: string) => string;
  checksumsUrl: string;
  binaryInArchive: string;
}

const MUTAGEN_VERSION = 'v0.18.1';

export const MUTAGEN: PinnedTool = {
  name: 'mutagen',
  version: MUTAGEN_VERSION,
  asset: (platform, arch) => {
    const os = platform === 'darwin' ? 'darwin' : 'linux';
    const target = arch === 'arm64' ? 'arm64' : 'amd64';
    return `mutagen_${os}_${target}_${MUTAGEN_VERSION}.tar.gz`;
  },
  url: (asset) =>
    `https://github.com/mutagen-io/mutagen/releases/download/${MUTAGEN_VERSION}/${asset}`,
  checksumsUrl: `https://github.com/mutagen-io/mutagen/releases/download/${MUTAGEN_VERSION}/SHA256SUMS`,
  binaryInArchive: 'mutagen',
};

export function toolPath(tool: PinnedTool): string {
  return join(paths().bin, tool.name);
}

export async function findTool(tool: PinnedTool): Promise<string | undefined> {
  const managed = toolPath(tool);

  if (await fileExists(managed)) {
    return managed;
  }

  return commandPath(tool.name);
}

export interface EnsureToolResult {
  path: string;
  installed: boolean;
  version: string | undefined;
}

export async function ensureTool(tool: PinnedTool): Promise<EnsureToolResult> {
  const existing = await findTool(tool);

  if (existing !== undefined) {
    return { path: existing, installed: false, version: await toolVersion(existing) };
  }

  if (process.platform === 'win32') {
    throw new CoramiError({
      code: 'capability_missing',
      message: `Automatic installation of ${tool.name} is not supported on Windows`,
      fix: `Install ${tool.name} manually and add it to the PATH`,
    });
  }

  const asset = tool.asset(process.platform, process.arch);
  const url = tool.url(asset);
  const directory = paths().bin;

  mkdirSync(directory, { recursive: true });
  const archive = join(directory, asset);

  const checksum = await fetchChecksum(tool.checksumsUrl, asset);
  const downloaded = await run('curl', ['-fsSL', url, '-o', archive]);

  if (!downloaded.ok) {
    throw new CoramiError({
      code: 'capability_missing',
      message: `Cannot download ${tool.name} from ${url}`,
      fix: downloaded.stderr.trim().split('\n').slice(0, 2).join(' '),
    });
  }

  const actual = await sha256(archive);

  if (checksum !== undefined && actual !== checksum) {
    throw new CoramiError({
      code: 'capability_missing',
      message: `Checksum mismatch for ${asset}`,
      fix: 'Download it again; if it keeps failing, report it',
      details: { expected: checksum, actual },
    });
  }

  const extracted = await extract(archive, directory, tool);
  await run('rm', ['-f', archive]);

  if (!extracted.ok) {
    throw new CoramiError({
      code: 'capability_missing',
      message: `Cannot extract ${asset}`,
      fix: extracted.stderr.trim().split('\n').slice(0, 2).join(' '),
    });
  }

  const extractedPath = findExtracted(tool, directory);

  chmodSync(extractedPath, 0o755);

  return { path: extractedPath, installed: true, version: await toolVersion(extractedPath) };
}

async function extract(
  archive: string,
  directory: string,
  tool: PinnedTool,
): Promise<{ ok: boolean; stderr: string }> {
  if (archive.endsWith('.bz2')) {
    const target = join(directory, tool.binaryInArchive);
    const result = await run('sh', [
      '-c',
      `bunzip2 -c ${shellQuote(archive)} > ${shellQuote(target)}`,
    ]);

    if (result.ok) {
      chmodSync(target, 0o755);
    }

    return { ok: result.ok, stderr: result.stderr };
  }

  if (archive.endsWith('.gz') || archive.endsWith('.tgz')) {
    const result = await run('tar', ['-xzf', archive, '-C', directory]);
    return { ok: result.ok, stderr: result.stderr };
  }

  return { ok: false, stderr: `unsupported archive: ${archive}` };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function findExtracted(tool: PinnedTool, directory: string): string {
  const candidates = [join(directory, tool.binaryInArchive), toolPath(tool)];

  for (const candidate of candidates) {
    if (Bun.file(candidate).size > 0) {
      return candidate;
    }
  }

  return toolPath(tool);
}

async function toolVersion(path: string): Promise<string | undefined> {
  const result = await run(path, ['version']);

  if (!result.ok) {
    return undefined;
  }

  return result.stdout.trim().split('\n')[0];
}

async function fetchChecksum(url: string, asset: string): Promise<string | undefined> {
  const response = await fetch(url).catch(() => undefined);

  if (response?.ok !== true) {
    return undefined;
  }

  const text = await response.text();

  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    const hash = parts[0];
    const name = parts.at(-1)?.replace(/^\*/, '');

    if (hash !== undefined && name === asset) {
      return hash;
    }
  }

  return undefined;
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest('hex');
}
