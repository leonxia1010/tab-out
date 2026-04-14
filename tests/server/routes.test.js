// tests/server/routes.test.js
// ─────────────────────────────────────────────────────────────────────────────
// HTTP integration tests for server/routes.js using supertest.
//
// Strategy: vi.mock can't reliably intercept the CJS `require('./db')` inside
// server/routes.js in this Vitest+CJS setup. Instead we point HOME at a temp
// directory BEFORE any server/* import, so config.js resolves CONFIG_DIR into
// tmpdir, db.js creates its SQLite file there, and routes.js gets the real
// (but isolated) DB. We clear every table before each test to keep them hermetic.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ── 1. Isolate HOME before any server/* import loads config.js ──────────────
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-out-test-'));
process.env.HOME = tmpHome;

// ── 2. Dynamic imports so HOME is honoured by config.js ─────────────────────
const dbModule = await import('../../server/db.js');
const routesModule = await import('../../server/routes.js');

// ── 3. Test app setup ───────────────────────────────────────────────────────
let app;

beforeEach(() => {
  // Wipe every table for a clean slate.
  dbModule.db.exec(`
    DELETE FROM deferred_tabs;
    DELETE FROM archives;
    DELETE FROM mission_urls;
    DELETE FROM missions;
    DELETE FROM meta;
  `);

  app = express();
  app.use(express.json());
  app.use('/api', routesModule.default);
});

afterAll(() => {
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ── Shared seeding helpers ──────────────────────────────────────────────────
function seedMission({ id, name, status = 'active', last_activity = '2026-04-10 10:00:00', dismissed = 0 }) {
  dbModule.upsertMission.run({
    id,
    name,
    summary: null,
    status,
    last_activity,
    created_at: '2026-04-01 00:00:00',
    updated_at: '2026-04-01 00:00:00',
    dismissed,
  });
}

function seedMissionUrl({ mission_id, url, title, visit_count = 1, last_visit = '2026-04-10 10:00:00' }) {
  dbModule.insertMissionUrl.run({ mission_id, url, title, visit_count, last_visit });
}

function seedDeferred({ url, title, favicon_url = null, source_mission = null, deferred_at, archived = 0, archived_at = null }) {
  return dbModule.db.prepare(`
    INSERT INTO deferred_tabs (url, title, favicon_url, source_mission, deferred_at, archived, archived_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(url, title, favicon_url, source_mission, deferred_at, archived, archived_at);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/missions', () => {
  it('returns empty array when no missions', async () => {
    const res = await request(app).get('/api/missions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns missions with urls attached', async () => {
    seedMission({ id: 'm1', name: 'Trip' });
    seedMissionUrl({ mission_id: 'm1', url: 'https://a.com', title: 'A', visit_count: 3 });
    seedMissionUrl({ mission_id: 'm1', url: 'https://b.com', title: 'B', visit_count: 1 });

    const res = await request(app).get('/api/missions');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('m1');
    expect(res.body[0].urls).toHaveLength(2);
    // ordered by visit_count DESC
    expect(res.body[0].urls[0].url).toBe('https://a.com');
  });

  it('excludes dismissed missions', async () => {
    seedMission({ id: 'active1', name: 'Active' });
    seedMission({ id: 'dismissed1', name: 'Dismissed', dismissed: 1 });

    const res = await request(app).get('/api/missions');
    expect(res.body.map(m => m.id)).toEqual(['active1']);
  });
});

describe('POST /api/missions/:id/dismiss', () => {
  it('marks mission dismissed=1', async () => {
    seedMission({ id: 'm1', name: 'ToDismiss' });
    const res = await request(app).post('/api/missions/m1/dismiss');
    expect(res.status).toBe(200);

    const row = dbModule.db.prepare('SELECT dismissed FROM missions WHERE id = ?').get('m1');
    expect(row.dismissed).toBe(1);
  });

  it('returns {success:true}', async () => {
    seedMission({ id: 'm1', name: 'ToDismiss' });
    const res = await request(app).post('/api/missions/m1/dismiss');
    expect(res.body).toEqual({ success: true });
  });

  it('handles non-existent id without crashing', async () => {
    const res = await request(app).post('/api/missions/does-not-exist/dismiss');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });
});

describe('POST /api/missions/:id/archive', () => {
  it('inserts archives row + dismisses mission', async () => {
    seedMission({ id: 'm1', name: 'Trip' });
    seedMissionUrl({ mission_id: 'm1', url: 'https://a.com', title: 'A' });

    const res = await request(app).post('/api/missions/m1/archive');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    const archive = dbModule.db.prepare('SELECT * FROM archives WHERE mission_id = ?').get('m1');
    expect(archive).toBeDefined();
    expect(archive.mission_name).toBe('Trip');
    const urls = JSON.parse(archive.urls_json);
    expect(urls).toHaveLength(1);
    expect(urls[0].url).toBe('https://a.com');

    const row = dbModule.db.prepare('SELECT dismissed FROM missions WHERE id = ?').get('m1');
    expect(row.dismissed).toBe(1);
  });

  it('returns 404 for non-existent mission', async () => {
    const res = await request(app).post('/api/missions/nope/archive');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 404 for already-dismissed mission', async () => {
    seedMission({ id: 'm1', name: 'Already', dismissed: 1 });
    const res = await request(app).post('/api/missions/m1/archive');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/stats', () => {
  it('returns totalMissions/totalUrls/abandonedMissions/lastAnalysis', async () => {
    seedMission({ id: 'a1', name: 'Active', status: 'active' });
    seedMission({ id: 'ab1', name: 'Abandoned', status: 'abandoned' });
    seedMissionUrl({ mission_id: 'a1', url: 'https://a.com', title: 'A' });
    seedMissionUrl({ mission_id: 'a1', url: 'https://b.com', title: 'B' });
    seedMissionUrl({ mission_id: 'ab1', url: 'https://c.com', title: 'C' });
    dbModule.setMeta.run({ key: 'last_analysis', value: '2026-04-14T10:00:00Z' });

    const res = await request(app).get('/api/stats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalMissions: 2,
      totalUrls: 3,
      abandonedMissions: 1,
      lastAnalysis: '2026-04-14T10:00:00Z',
    });
  });

  it('excludes dismissed missions from counts', async () => {
    seedMission({ id: 'a1', name: 'Active' });
    seedMission({ id: 'd1', name: 'Dismissed', dismissed: 1 });
    seedMissionUrl({ mission_id: 'a1', url: 'https://a.com', title: 'A' });
    seedMissionUrl({ mission_id: 'd1', url: 'https://d.com', title: 'D' });

    const res = await request(app).get('/api/stats');
    expect(res.body.totalMissions).toBe(1);
    expect(res.body.totalUrls).toBe(1);
  });

  it('returns null lastAnalysis when meta empty', async () => {
    const res = await request(app).get('/api/stats');
    expect(res.body.lastAnalysis).toBeNull();
  });
});

describe('POST /api/defer', () => {
  it('creates deferred_tabs rows from body.tabs', async () => {
    const res = await request(app)
      .post('/api/defer')
      .send({ tabs: [
        { url: 'https://a.com', title: 'A', favicon_url: 'https://a.com/fav.ico', source_mission: 'm1' },
        { url: 'https://b.com', title: 'B' },
      ] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.deferred).toHaveLength(2);

    const rows = dbModule.db.prepare('SELECT * FROM deferred_tabs ORDER BY id').all();
    expect(rows).toHaveLength(2);
    expect(rows[0].url).toBe('https://a.com');
    expect(rows[0].favicon_url).toBe('https://a.com/fav.ico');
    expect(rows[0].source_mission).toBe('m1');
    expect(rows[1].favicon_url).toBeNull();
  });

  it('returns 400 when tabs array empty', async () => {
    const res = await request(app).post('/api/defer').send({ tabs: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tabs/i);
  });

  it('returns 400 when body.tabs missing', async () => {
    const res = await request(app).post('/api/defer').send({});
    expect(res.status).toBe(400);
  });

  it('skips tabs with missing url or title', async () => {
    const res = await request(app)
      .post('/api/defer')
      .send({ tabs: [
        { url: 'https://ok.com', title: 'OK' },
        { url: 'https://no-title.com' },
        { title: 'no-url' },
      ] });

    expect(res.status).toBe(200);
    const rows = dbModule.db.prepare('SELECT * FROM deferred_tabs').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe('https://ok.com');
  });

  it('handles optional favicon_url and source_mission', async () => {
    const res = await request(app)
      .post('/api/defer')
      .send({ tabs: [{ url: 'https://x.com', title: 'X' }] });

    expect(res.status).toBe(200);
    const row = dbModule.db.prepare('SELECT * FROM deferred_tabs').get();
    expect(row.favicon_url).toBeNull();
    expect(row.source_mission).toBeNull();
  });
});

describe('GET /api/deferred', () => {
  it('returns {active, archived} split', async () => {
    seedDeferred({ url: 'https://act.com', title: 'Act', deferred_at: '2026-04-10 10:00:00', archived: 0 });
    seedDeferred({ url: 'https://arc.com', title: 'Arc', deferred_at: '2026-04-01 10:00:00', archived: 1, archived_at: '2026-04-05 10:00:00' });

    const res = await request(app).get('/api/deferred');
    expect(res.status).toBe(200);
    expect(res.body.active).toHaveLength(1);
    expect(res.body.active[0].url).toBe('https://act.com');
    expect(res.body.archived).toHaveLength(1);
    expect(res.body.archived[0].url).toBe('https://arc.com');
  });

  it('runs age-out as side effect', async () => {
    dbModule.db.prepare(`
      INSERT INTO deferred_tabs (url, title, deferred_at, archived)
      VALUES ('https://old.com', 'Old', datetime('now', '-31 days'), 0)
    `).run();

    const res = await request(app).get('/api/deferred');
    expect(res.status).toBe(200);
    expect(res.body.active.map(r => r.url)).not.toContain('https://old.com');
    expect(res.body.archived.map(r => r.url)).toContain('https://old.com');
  });
});

describe('GET /api/deferred/search', () => {
  it('returns empty results when q.length < 2', async () => {
    const res = await request(app).get('/api/deferred/search?q=a');
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('matches title', async () => {
    seedDeferred({ url: 'https://a.com', title: 'React Guide', deferred_at: '2026-04-01 10:00:00', archived: 1, archived_at: '2026-04-05 10:00:00' });
    seedDeferred({ url: 'https://b.com', title: 'Vue Tutorial', deferred_at: '2026-04-01 10:00:00', archived: 1, archived_at: '2026-04-05 10:00:00' });

    const res = await request(app).get('/api/deferred/search?q=React');
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].url).toBe('https://a.com');
  });

  it('matches url', async () => {
    seedDeferred({ url: 'https://github.com/foo', title: 'Foo', deferred_at: '2026-04-01 10:00:00', archived: 1, archived_at: '2026-04-05 10:00:00' });
    const res = await request(app).get('/api/deferred/search?q=github');
    expect(res.body.results).toHaveLength(1);
  });

  it('route ordering: /deferred/search NOT matched as PATCH /deferred/:id', async () => {
    // Regression test — GET /deferred/search must be registered before
    // PATCH /deferred/:id, otherwise Express would route /search to :id handler.
    seedDeferred({ url: 'https://a.com', title: 'React', deferred_at: '2026-04-01 10:00:00', archived: 1, archived_at: '2026-04-05 10:00:00' });
    const res = await request(app).get('/api/deferred/search?q=React');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('results');
  });
});

describe('PATCH /api/deferred/:id', () => {
  it('checked:true calls checkDeferred', async () => {
    const { lastInsertRowid: id } = seedDeferred({ url: 'https://a.com', title: 'A', deferred_at: '2026-04-10 10:00:00' });

    const res = await request(app).patch(`/api/deferred/${id}`).send({ checked: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    const row = dbModule.db.prepare('SELECT * FROM deferred_tabs WHERE id = ?').get(id);
    expect(row.checked).toBe(1);
    expect(row.archived).toBe(1);
  });

  it('dismissed:true calls dismissDeferred', async () => {
    const { lastInsertRowid: id } = seedDeferred({ url: 'https://b.com', title: 'B', deferred_at: '2026-04-10 10:00:00' });

    const res = await request(app).patch(`/api/deferred/${id}`).send({ dismissed: true });
    expect(res.status).toBe(200);

    const row = dbModule.db.prepare('SELECT * FROM deferred_tabs WHERE id = ?').get(id);
    expect(row.dismissed).toBe(1);
    expect(row.archived).toBe(1);
  });

  it('returns 400 when neither checked nor dismissed', async () => {
    const { lastInsertRowid: id } = seedDeferred({ url: 'https://c.com', title: 'C', deferred_at: '2026-04-10 10:00:00' });
    const res = await request(app).patch(`/api/deferred/${id}`).send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid id', async () => {
    const res = await request(app).patch('/api/deferred/0').send({ checked: true });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/update-status', () => {
  // Note: routes.js captures getUpdateStatus via require-time destructure, so
  // we can't intercept it from the outside. These are smoke tests verifying
  // the endpoint is wired and returns a well-formed response.
  it('returns 200 with an updateAvailable boolean', async () => {
    const res = await request(app).get('/api/update-status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('updateAvailable');
    expect(typeof res.body.updateAvailable).toBe('boolean');
  });

  it('response shape includes currentCommit and checkedAt keys', async () => {
    const res = await request(app).get('/api/update-status');
    expect(res.body).toHaveProperty('currentCommit');
    expect(res.body).toHaveProperty('checkedAt');
  });
});
