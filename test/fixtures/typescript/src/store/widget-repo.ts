import { BaseRepo } from './base.js';
import type { Findable, Pool } from './base.js';
import { WIDGET_TABLE, isVisible } from '@app/models/widget.js';
import type { Widget, WidgetId } from '@app/models/widget.js';

/** Reads widget rows. */
export class WidgetRepo extends BaseRepo implements Findable {
  readonly label = 'widgets';

  private readonly cache = new Map<WidgetId, Widget>();

  constructor(pool: Pool) {
    super(pool);
  }

  tableName(): string {
    return WIDGET_TABLE;
  }

  /** Fetch one widget row, or null when it is gone or hidden. */
  async find(id: WidgetId): Promise<Widget | null> {
    const cached = this.cache.get(id);
    if (cached) return cached;

    const rows = await this.pool.query(
      `
        SELECT w.id, w.name, w.owner_id, w.status
        FROM widgets w
        JOIN owners o ON o.id = w.owner_id
        WHERE w.id = $1
      `,
      [id],
    );

    const widget = rows[0] as Widget | undefined;
    if (!widget || !isVisible(widget)) return null;
    this.remember(widget);
    return widget;
  }

  onMiss = (id: WidgetId): void => {
    this.cache.delete(id);
  };

  private remember(widget: Widget): void {
    this.cache.set(widget.id, widget);
    this.touch(widget.id);
  }
}

/** Build a store over the default pool. */
export function openWidgetRepo(pool: Pool): WidgetRepo {
  return new WidgetRepo(pool);
}
