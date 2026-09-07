import type { Pool } from './base.js';

/** The one pool the service uses. Not a symbol worth indexing. */
export const pool: Pool = {
  async query(sql: string, params?: unknown[]): Promise<unknown[]> {
    void sql;
    void params;
    return [];
  },
};
