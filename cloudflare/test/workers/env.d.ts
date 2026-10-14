declare module 'cloudflare:workers' {
  export const exports: Record<string, unknown>;
}
declare module 'cloudflare:test' {
  export const env: Record<string, any>;
  export function runInDurableObject<O, R>(stub: DurableObjectStub, callback: (instance: O, state: DurableObjectState) => R | Promise<R>): Promise<R>;
  export function runDurableObjectAlarm(stub: DurableObjectStub): Promise<boolean>;
  export function evictDurableObject(stub: DurableObjectStub): Promise<void>;
  export function applyD1Migrations(db: D1Database, migrations: unknown[], table?: string): Promise<void>;
}
