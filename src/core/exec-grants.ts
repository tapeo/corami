export const GRANT_MINUTES = 15;

export interface ExecGrant {
  project: string;
  until: string;
}

export function newGrant(project: string, now = Date.now()): ExecGrant {
  return { project, until: new Date(now + GRANT_MINUTES * 60_000).toISOString() };
}

export function activeGrants(grants: ExecGrant[], now = Date.now()): ExecGrant[] {
  return grants.filter((grant) => Date.parse(grant.until) > now);
}

export function activeGrant(
  grants: ExecGrant[],
  project: string,
  now = Date.now(),
): ExecGrant | undefined {
  return activeGrants(grants, now).find((grant) => grant.project === project);
}

export function addGrant(grants: ExecGrant[], grant: ExecGrant, now = Date.now()): ExecGrant[] {
  const rest = activeGrants(grants, now).filter((item) => item.project !== grant.project);

  return [...rest, grant];
}

export function grantMinutesLeft(grant: ExecGrant, now = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(grant.until) - now) / 60_000));
}

export function grantsJson(grants: ExecGrant[]): string {
  return `${JSON.stringify(grants, null, 2)}\n`;
}

export function grantsFromJson(text: string): ExecGrant[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter(isGrant);
}

function isGrant(value: unknown): value is ExecGrant {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.project === 'string' &&
    typeof record.until === 'string' &&
    !Number.isNaN(Date.parse(record.until))
  );
}
