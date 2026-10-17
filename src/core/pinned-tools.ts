import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { paths } from '@/core/config.ts';
import { CoramiError } from '@/core/errors.ts';
import { commandPath, fileExists, run, shellQuote } from '@/core/exec.ts';

export interface PinnedTool {
  name: string;
  version: string;
  asset: (platform: NodeJS.Platform, arch: string) => string;
  url: (asset: string) => string;
  /** The sha256 of every asset, from the `SHA256SUMS` of the release. */
  checksums: (asset: string) => string | undefined;
  binaryInArchive: string;
}

const MUTAGEN_VERSION = 'v0.18.1';

// The sums of the release, written down: the file of the release is not
// fetched, so a missing or changed one cannot take the check away.
const MUTAGEN_CHECKSUMS: Record<string, string> = {
  [`mutagen_darwin_amd64_${MUTAGEN_VERSION}.tar.gz`]:
    '7d06f7d8fcfe90bc7e55cc834a2f2f20c2e0af9ea9bc35911fc4341ad56a9bbf',
  [`mutagen_darwin_arm64_${MUTAGEN_VERSION}.tar.gz`]:
    '6f810416d9e5fc4fd5e18431146f8b3c5a2056ba5a24f76c1e66da86eb3257e2',
  [`mutagen_linux_amd64_${MUTAGEN_VERSION}.tar.gz`]:
    '7735286c778cc438418209f24d03a64f3a0151c8065ef0fe079cfaf093af6f8f',
  [`mutagen_linux_arm64_${MUTAGEN_VERSION}.tar.gz`]:
    'bcba735aebf8cbc11da9b3742118a665599ac697fa06bc5751cac8dcd540db8a',
  [`mutagen_windows_amd64_${MUTAGEN_VERSION}.tar.gz`]:
    '3e237e77f69959ed520a0f877330a431507bb0a85d9da7919764ba0c87b702c7',
  [`mutagen_windows_arm64_${MUTAGEN_VERSION}.tar.gz`]:
    '9ac53447e46f019be9d37f49c00eeed8635966b885ed29ef06b3ff19afdee532',
};

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
  checksums: (asset) => MUTAGEN_CHECKSUMS[asset],
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

  const checksum = tool.checksums(asset);

  if (checksum === undefined) {
    throw new CoramiError({
      code: 'capability_missing',
      message: `No pinned checksum for ${asset}`,
      fix: `Add the sha256 of the asset from the SHA256SUMS of ${tool.name} ${tool.version} to pinned-tools.ts`,
    });
  }

  const downloaded = await run('curl', ['-fsSL', url, '-o', archive]);

  if (!downloaded.ok) {
    throw new CoramiError({
      code: 'capability_missing',
      message: `Cannot download ${tool.name} from ${url}`,
      fix: downloaded.stderr.trim().split('\n').slice(0, 2).join(' '),
    });
  }

  const actual = await sha256(archive);

  if (actual !== checksum) {
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

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest('hex');
}
