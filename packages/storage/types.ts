import type { PoolClient } from 'pg';

export type TransportMode = 'railway-private' | 'verify-full' | 'local-test';
export type DatabaseConnectionOptions = Readonly<{
  transportMode: TransportMode;
  ca?: string;
}>;
export type OpenStoreOptions = DatabaseConnectionOptions & Readonly<{
  connectionString: string;
  expectedStoreId: string;
  maintenance: boolean;
  deploymentEpoch: string;
  /** Nonnegative safe integer Unix seconds. Row timestamps elsewhere are Unix milliseconds. */
  tokenIatAfter: number;
  now(): number;
}>;
export type MigrationOptions = DatabaseConnectionOptions & Readonly<{
  migrationUrl: string;
  initialize: boolean;
  maintenance: boolean;
  expectedStoreId: string;
  deploymentEpoch: string;
}>;
/** All repository work uses this one checked-out client. Lock order: user, membership, device, context, pairing, lease. */
export type Transaction = Pick<PoolClient, 'query'>;
export type Store = Readonly<{
  bootId: string;
  expectedStoreId: string;
  deploymentEpoch: string;
  tokenIatAfter: number;
  transaction<T>(action: (transaction: Transaction) => Promise<T>): Promise<T>;
  ready(): Promise<boolean>;
  setMaintenance(enabled: boolean): Promise<void>;
  onUnavailable(listener: () => void): () => void;
  close(): Promise<void>;
}>;
