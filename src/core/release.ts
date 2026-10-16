import { chmodSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { CoramiError } from '@/core/errors.ts';

export const REPO = process.env.CORAMI_REPO ?? 'tapeo/corami';

export function releasesApi(repo = REPO): string {
  return `https://api.github.com/repos/${repo}/releases`;
}

export function authHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;

  if (token === undefined || token === '') {
    return {};
  }

  return { authorization: `Bearer ${token}` };
}

export interface ReleaseAsset {
  name: string;
  url: string;
  api_url?: string | undefined;
}

export function downloadUrl(asset: ReleaseAsset): string {
  const token = process.env.GITHUB_TOKEN;

  if (token !== undefined && token !== '' && asset.api_url !== undefined) {
    return asset.api_url;
  }

  return asset.url;
}

export interface ReleaseInfo {
  tag: string;
  version: string;
  assets: ReleaseAsset[];
}

export function assetNameFor(platform: NodeJS.Platform, arch: string): string {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux';
  const target = arch === 'arm64' ? 'arm64' : 'x64';
  const extension = platform === 'win32' ? '.exe' : '';

  return `corami-${os}-${target}${extension}`;
}

export function parseVersion(value: string): string {
  return value.replace(/^v/, '');
}

export function isNewer(candidate: string, current: string): boolean {
  const left = parseVersion(candidate)
    .split('.')
    .map((part) => Number(part));
  const right = parseVersion(current)
    .split('.')
    .map((part) => Number(part));

  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;

    if (a > b) {
      return true;
    }

    if (a < b) {
      return false;
    }
  }

  return false;
}

export async function latestRelease(
  repo = REPO,
): Promise<{ release?: ReleaseInfo | undefined; reason?: 'no_releases' | 'unreachable' }> {
  const response = await fetch(`${releasesApi(repo)}/latest`, {
    headers: { accept: 'application/vnd.github+json', ...authHeaders() },
    signal: AbortSignal.timeout(20_000),
  }).catch(() => undefined);

  if (response === undefined) {
    return { reason: 'unreachable' };
  }

  if (response.status === 404) {
    return { reason: 'no_releases' };
  }

  if (!response.ok) {
    return { reason: 'unreachable' };
  }

  const body = (await response.json()) as {
    tag_name?: string;
    assets?: Array<{ name?: string; browser_download_url?: string; url?: string }>;
  };

  if (typeof body.tag_name !== 'string') {
    return { reason: 'no_releases' };
  }

  return {
    release: {
      tag: body.tag_name,
      version: parseVersion(body.tag_name),
      assets: (body.assets ?? [])
        .filter(
          (asset) =>
            typeof asset.name === 'string' && typeof asset.browser_download_url === 'string',
        )
        .map((asset) => ({
          name: String(asset.name),
          url: String(asset.browser_download_url),
          api_url: typeof asset.url === 'string' ? asset.url : undefined,
        })),
    },
  };
}

export async function fetchChecksums(release: ReleaseInfo): Promise<Map<string, string>> {
  const asset = release.assets.find((entry) => entry.name === 'checksums.txt');

  if (asset === undefined) {
    return new Map();
  }

  const response = await fetchAsset(downloadUrl(asset), 20_000);

  if (response?.ok !== true) {
    return new Map();
  }

  const checksums = new Map<string, string>();

  for (const line of (await response.text()).split('\n')) {
    const parts = line.trim().split(/\s+/);
    const hash = parts[0];
    const name = parts.at(-1)?.replace(/^\*/, '');

    if (hash !== undefined && name !== undefined) {
      checksums.set(name, hash);
    }
  }

  return checksums;
}

export async function fetchAsset(url: string, timeoutMs: number): Promise<Response | undefined> {
  const headers = { ...authHeaders(), accept: 'application/octet-stream' };
  const first = await fetch(url, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => undefined);

  if (first === undefined) {
    return undefined;
  }

  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get('location');

    if (location === null) {
      return undefined;
    }

    return fetch(location, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => undefined);
  }

  return first;
}

export interface DownloadResult {
  path: string;
  version: string;
}

export async function downloadReleaseBinary(options: {
  release: ReleaseInfo;
  platform: NodeJS.Platform;
  arch: string;
  currentBinary: string;
}): Promise<DownloadResult> {
  const assetName = assetNameFor(options.platform, options.arch);
  const asset = options.release.assets.find((entry) => entry.name === assetName);

  if (asset === undefined) {
    throw new CoramiError({
      code: 'generic',
      message: `The release ${options.release.tag} has no asset for this machine (${assetName})`,
      fix: 'Download it by hand from the releases page',
    });
  }

  const response = await fetchAsset(downloadUrl(asset), 120_000);

  if (response?.ok !== true) {
    throw new CoramiError({
      code: 'generic',
      message: `Cannot download ${assetName}`,
      fix: 'Check the connection and the token, then retry corami update',
    });
  }

  const content = new Uint8Array(await response.arrayBuffer());
  const checksums = await fetchChecksums(options.release);
  const expected = checksums.get(assetName);

  if (expected !== undefined) {
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(content);
    const actual = hasher.digest('hex');

    if (actual !== expected) {
      throw new CoramiError({
        code: 'generic',
        message: `Checksum mismatch for ${assetName}`,
        fix: 'Download it again; if it keeps failing, report it',
        details: { expected, actual },
      });
    }
  }

  const temporary = `${options.currentBinary}.new`;
  await Bun.write(temporary, content);
  chmodSync(temporary, 0o755);

  return { path: temporary, version: options.release.version };
}

export function replaceBinary(currentBinary: string, downloaded: string): void {
  const backup = `${currentBinary}.old`;

  try {
    renameSync(currentBinary, backup);
  } catch {
    // the current binary may be running from a path we cannot rename; try the direct replace below
  }

  try {
    renameSync(downloaded, currentBinary);
  } catch (error) {
    throw new CoramiError({
      code: 'generic',
      message: `Cannot replace ${currentBinary}`,
      fix: error instanceof Error ? error.message : String(error),
    });
  }

  rmSync(backup, { force: true });
}
