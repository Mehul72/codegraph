// Widget shapes shared by the store and the HTTP layer.

/** Anything that carries a creation timestamp. */
export interface Entity {
  createdAt: string;
}

/** A widget row as it is stored. */
export interface Widget extends Entity {
  id: WidgetId;
  name: string;
  ownerId: string;
  status: WidgetStatus;
}

/** Primary key of a widget row. */
export type WidgetId = string;

export enum WidgetStatus {
  Active = 'active',
  Retired = 'retired',
}

export const WIDGET_TABLE = 'widgets';

/** True for widgets that should still be served. */
export function isVisible(widget: Widget): boolean {
  return widget.status === WidgetStatus.Active;
}

/** Url-safe form of a widget name. */
function slugify(widget: Widget): string {
  return widget.name.toLowerCase().replace(/\s+/g, '-');
}

/** First entry that matches, or undefined when none does. */
export function firstMatch<T extends Entity>(items: T[], match: (item: T) => boolean): T | undefined {
  return items.find(match);
}

export { slugify };
