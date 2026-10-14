import postgres from 'postgres';

/** Minimal parameterised-SQL interface; every statement is a single round trip. */
export interface Db {
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
}
export type Row = Record<string, any>;

export interface ClosableDb extends Db {
  close(): Promise<void>;
}

/**
 * postgres.js over a Hyperdrive connection string (or any Postgres URL in tests).
 * Hyperdrive pools in transaction mode, so every queue operation is written as
 * ONE statement (data-modifying CTEs) and never relies on session state.
 */
export function connect(connectionString: string, options: postgres.Options<{}> = {}): ClosableDb {
  const sql = postgres(connectionString, { max: 5, fetch_types: false, onnotice: () => {}, ...options });
  return {
    async query<T>(text: string, params: unknown[] = []) {
      return (await sql.unsafe(text, params as any[])) as unknown as T[];
    },
    close: () => sql.end({ timeout: 5 }),
  };
}

export function nowIso(): string {
  // Matches Python's datetime.now(timezone.utc).isoformat() ordering semantics.
  return new Date().toISOString().replace('Z', '+00:00');
}

export function vectorLiteral(vector: number[]): string {
  if (!vector.length || !vector.every(Number.isFinite)) throw new Error('Invalid embedding vector');
  return `[${vector.join(',')}]`;
}
