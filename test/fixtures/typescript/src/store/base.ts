import type { Widget, WidgetId } from '../models/widget.js';

/** The slice of a database driver the stores actually use. */
export interface Pool {
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
}

/** Anything that can be looked up by id. */
export interface Findable extends Entity {
  find(id: WidgetId): Promise<Widget | null>;
  readonly label: string;
  onMiss: (id: WidgetId) => void;
}

/** The bit of Entity the stores care about. */
export interface Entity {
  readonly label: string;
}

/**
 * Shared plumbing for the row stores. Subclasses only have to name their
 * table.
 */
export abstract class BaseRepo {
  private readonly hits = new Map<string, number>();

  protected constructor(protected readonly pool: Pool) {}

  /** Table this store reads from. */
  abstract tableName(): string;

  describe(): string {
    return `store over ${this.tableName()}`;
  }

  private count(key: string): void {
    this.hits.set(key, (this.hits.get(key) ?? 0) + 1);
  }

  protected touch(key: string): void {
    this.count(key);
  }
}

export const DEFAULT_TIMEOUT_MS = 5000;
