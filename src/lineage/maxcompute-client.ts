export type MaxComputeRow = Record<string, string>;

export interface MaxComputeQueryOptions {
  validateOnly?: boolean;
}

export interface MaxComputeQueryClient {
  query(sql: string, fields: readonly string[], options?: MaxComputeQueryOptions): Promise<MaxComputeRow[]>;
  stream?(sql: string, fields: readonly string[], options?: MaxComputeQueryOptions): AsyncIterable<MaxComputeRow>;
}

export interface MaxComputeCredentials {
  accessKeyId: string;
  accessKeySecret: string;
}
