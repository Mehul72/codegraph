import { useState } from 'react';
import { isVisible } from '../models/widget.js';
import type { Widget } from '@app/models/widget.js';

/** Props for one widget card. */
export interface WidgetCardProps {
  widget: Widget;
  onPick: (id: string) => void;
}

/** One widget rendered as a card. */
export default function WidgetCard({ widget, onPick }: WidgetCardProps) {
  const [open, setOpen] = useState(false);
  if (!isVisible(widget)) return null;

  return (
    <article className="widget-card" onClick={() => onPick(widget.id)}>
      <h3>{widget.name}</h3>
      {open ? <StatusBadge status={widget.status} /> : null}
      <button type="button" onClick={() => setOpen(!open)}>
        toggle
      </button>
    </article>
  );
}

/** Small coloured status pill. */
export const StatusBadge = ({ status }: { status: string }) => <span className="badge">{status}</span>;
