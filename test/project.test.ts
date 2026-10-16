import { describe, expect, test } from 'bun:test';
import { CoramiError } from '@/core/errors.ts';
import { PORT_RANGE_START } from '@/core/ports.ts';
import {
  allocatePublicPort,
  planServeRules,
  previewUrl,
  projectForPath,
  validatePreviewName,
  validateTargetPort,
} from '@/core/previews.ts';

describe('allocatePublicPort', () => {
  test('starts at the first port of the range', () => {
    expect(allocatePublicPort([])).toBe(PORT_RANGE_START);
  });

  test('skips the ports already taken', () => {
    expect(allocatePublicPort([PORT_RANGE_START, PORT_RANGE_START + 1])).toBe(PORT_RANGE_START + 2);
  });

  test('fills the gaps', () => {
    expect(allocatePublicPort([PORT_RANGE_START, PORT_RANGE_START + 2])).toBe(PORT_RANGE_START + 1);
  });
});

describe('validateTargetPort', () => {
  test('accepts a normal dev server port', () => {
    expect(() => validateTargetPort(3000)).not.toThrow();
  });

  test('rejects the daemon port and the preview range', () => {
    expect(() => validateTargetPort(7420)).toThrow(CoramiError);
    expect(() => validateTargetPort(PORT_RANGE_START + 1)).toThrow(CoramiError);
  });

  test('rejects nonsense', () => {
    expect(() => validateTargetPort(0)).toThrow(CoramiError);
    expect(() => validateTargetPort(70_000)).toThrow(CoramiError);
    expect(() => validateTargetPort(Number.NaN)).toThrow(CoramiError);
  });
});

describe('validatePreviewName', () => {
  test('accepts letters, digits, dots, dashes and underscores', () => {
    expect(() => validatePreviewName('web')).not.toThrow();
    expect(() => validatePreviewName('web-2.staging_x')).not.toThrow();
  });

  test('rejects names with spaces or slashes', () => {
    expect(() => validatePreviewName('my web')).toThrow(CoramiError);
    expect(() => validatePreviewName('a/b')).toThrow(CoramiError);
  });
});

describe('previewUrl', () => {
  test('uses the MagicDNS name and the public port', () => {
    expect(previewUrl('corami.tail1a2b3c.ts.net', 4101)).toBe(
      'https://corami.tail1a2b3c.ts.net:4101',
    );
  });
});

describe('planServeRules', () => {
  test('creates the missing rules and removes the stale ones', () => {
    const plan = planServeRules([4100, 4102], [4100, 4101]);

    expect(plan.add).toEqual([4102]);
    expect(plan.remove).toEqual([4101]);
  });

  test('never touches rules outside the range', () => {
    const plan = planServeRules([4100], [4096, 7420, 4100]);

    expect(plan.add).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  test('is empty when the rules already match', () => {
    const plan = planServeRules([4100, 4101], [4101, 4100]);

    expect(plan).toEqual({ add: [], remove: [] });
  });
});

describe('projectForPath', () => {
  const projects = [
    { name: 'shop-app', path: '/root/corami/projects/shop-app' },
    { name: 'other', path: '/root/corami/projects/other' },
  ];

  test('finds the project that contains the folder', () => {
    expect(projectForPath('/root/corami/projects/shop-app/apps/web', projects)).toBe('shop-app');
  });

  test('matches the root itself', () => {
    expect(projectForPath('/root/corami/projects/other', projects)).toBe('other');
  });

  test('does not match a sibling with a shared prefix', () => {
    expect(projectForPath('/root/corami/projects/shop-app-2', projects)).toBeUndefined();
  });

  test('returns nothing outside the projects', () => {
    expect(projectForPath('/tmp', projects)).toBeUndefined();
  });

  test('picks the longest path when one contains the other', () => {
    const nested = [
      { name: 'parent', path: '/srv/code' },
      { name: 'child', path: '/srv/code/app' },
    ];

    expect(projectForPath('/srv/code/app/web', nested)).toBe('child');
  });
});
