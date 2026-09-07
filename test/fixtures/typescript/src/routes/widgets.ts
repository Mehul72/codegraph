// HTTP surface for widgets.

import express from 'express';
import type { Request, Response, Router } from 'express';
import { openWidgetRepo } from '../store/widget-repo.js';
import { pool } from '@app/store/pool.js';
import type { Widget } from '@app/models/widget.js';
import '../telemetry.js';

export const DEFAULT_PAGE_SIZE = 25;

const router = express.Router();
const repo = openWidgetRepo(pool);

/** Serve one widget as JSON. */
export async function showWidget(req: Request, res: Response): Promise<void> {
  const widget = await repo.find(String(req.params.id));
  if (!widget) {
    res.status(404).end();
    return;
  }
  res.json(widget);
}

/** Ids of every stored widget, oldest first. */
export const listWidgetIds = async (): Promise<string[]> => {
  const rows = await pool.query('SELECT id FROM widgets ORDER BY created_at');
  return rows.map((row) => String(row));
};

/** The card renderer, loaded lazily so the HTTP path skips the UI bundle. */
export async function loadCardRenderer(): Promise<unknown> {
  const ui = await import('../ui/WidgetCard.js');
  return ui.default;
}

/** Mount the widget routes on a router. */
export function registerWidgetRoutes(target: Router = router): Router {
  target.get('/widgets/:id', showWidget);
  target.post('/widgets', async (req: Request, res: Response) => {
    res.status(201).json(await buildWidget(req));
  });
  target.use('/widgets', logTraffic);
  return target;
}

function buildWidget(req: Request): Promise<Widget> {
  return Promise.resolve(req.body as Widget);
}

function logTraffic(_req: Request, _res: Response, next: () => void): void {
  next();
}

export default registerWidgetRoutes;
