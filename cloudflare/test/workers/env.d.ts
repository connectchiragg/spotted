declare module 'cloudflare:workers' {
  export const exports: Record<string, unknown>;
}
declare module 'cloudflare:test' {
  export const env: Record<string, any>;
  export function applyD1Migrations(db: D1Database, migrations: unknown[], table?: string): Promise<void>;
}
