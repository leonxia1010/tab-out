// tests/server/db.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Characterization tests for the prepared statements exported by server/db.js.
//
// Strategy (matches routes.test.js): point HOME at a tmp dir BEFORE importing
// server/db.js, so config.js resolves CONFIG_DIR into tmpdir, db.js opens a
// fresh SQLite file there, and we exercise the real prepared statements.
// Each test wipes every table for isolation. No schema is duplicated.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Isolate HOME before the server/* import triggers config.js
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-out-test-'));
process.env.HOME = tmpHome;

const db = await import('../../server/db.js');

beforeEach(() => {
  db.db.exec(`
    DELETE FROM deferred_tabs;
    DELETE FROM archives;
    DELETE FROM mission_urls;
    DELETE FROM missions;
    DELETE FROM meta;
  `);
});

afterAll(() => {
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// Raw-insert helper: lets us bypass DEFAULT datetime('now') so we can
// seed rows with precise timestamps for ordering / age-out tests.
function insertDeferredRaw({ url, title, favicon_url = null, source_mission = null, deferred_at, archived = 0, archived_at = null }) {
  return db.db.prepare(`
    INSERT INTO deferred_tabs (url, title, favicon_url, source_mission, deferred_at, archived, archived_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(url, title, favicon_url, source_mission, deferred_at, archived, archived_at);
}

describe('deferred_tabs prepared statements', () => {
  it('insertDeferred creates row with all fields', () => {
    db.insertDeferred.run({
      url: 'https://example.com/a',
      title: 'Example A',
      favicon_url: 'https://example.com/favicon.ico',
      source_mission: 'm1',
    });

    const rows = db.db.prepare('SELECT * FROM deferred_tabs').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      url: 'https://example.com/a',
      title: 'Example A',
      favicon_url: 'https://example.com/favicon.ico',
      source_mission: 'm1',
      checked: 0,
      dismissed: 0,
      archived: 0,
    });
    expect(rows[0].deferred_at).toBeTruthy();
  });

  it('insertDeferred handles null favicon_url', () => {
    db.insertDeferred.run({
      url: 'https://example.com/b',
      title: 'Example B',
      favicon_url: null,
      source_mission: null,
    });

    const row = db.db.prepare('SELECT * FROM deferred_tabs WHERE url = ?').get('https://example.com/b');
    expect(row.favicon_url).toBeNull();
    expect(row.source_mission).toBeNull();
  });

  it('getDeferredActive excludes archived rows', () => {
    insertDeferredRaw({ url: 'https://a.com', title: 'A', deferred_at: '2026-04-10 10:00:00', archived: 0 });
    insertDeferredRaw({ url: 'https://b.com', title: 'B', deferred_at: '2026-04-10 11:00:00', archived: 1, archived_at: '2026-04-11 10:00:00' });

    const active = db.getDeferredActive.all();
    expect(active).toHaveLength(1);
    expect(active[0].url).toBe('https://a.com');
  });

  it('getDeferredActive orders by deferred_at DESC', () => {
    insertDeferredRaw({ url: 'https://older.com', title: 'Older', deferred_at: '2026-04-01 10:00:00' });
    insertDeferredRaw({ url: 'https://newer.com', title: 'Newer', deferred_at: '2026-04-10 10:00:00' });
    insertDeferredRaw({ url: 'https://middle.com', title: 'Middle', deferred_at: '2026-04-05 10:00:00' });

    const active = db.getDeferredActive.all();
    expect(active.map(r => r.url)).toEqual([
      'https://newer.com',
      'https://middle.com',
      'https://older.com',
    ]);
  });

  it('getDeferredArchived includes both checked and dismissed', () => {
    insertDeferredRaw({ url: 'https://checked.com', title: 'Checked', deferred_at: '2026-04-01 10:00:00', archived: 1, archived_at: '2026-04-10 10:00:00' });
    insertDeferredRaw({ url: 'https://dismissed.com', title: 'Dismissed', deferred_at: '2026-04-02 10:00:00', archived: 1, archived_at: '2026-04-11 10:00:00' });
    insertDeferredRaw({ url: 'https://active.com', title: 'Active', deferred_at: '2026-04-03 10:00:00', archived: 0 });

    db.db.prepare('UPDATE deferred_tabs SET checked = 1 WHERE url = ?').run('https://checked.com');
    db.db.prepare('UPDATE deferred_tabs SET dismissed = 1 WHERE url = ?').run('https://dismissed.com');

    const archived = db.getDeferredArchived.all();
    const urls = archived.map(r => r.url).sort();
    expect(urls).toEqual(['https://checked.com', 'https://dismissed.com']);
  });

  it('checkDeferred sets checked=1, archived=1, checked_at, archived_at', () => {
    const { lastInsertRowid: id } = db.insertDeferred.run({
      url: 'https://x.com', title: 'X', favicon_url: null, source_mission: null,
    });

    db.checkDeferred.run({ id });

    const row = db.db.prepare('SELECT * FROM deferred_tabs WHERE id = ?').get(id);
    expect(row.checked).toBe(1);
    expect(row.archived).toBe(1);
    expect(row.checked_at).toBeTruthy();
    expect(row.archived_at).toBeTruthy();
    expect(row.dismissed).toBe(0);
  });

  it('dismissDeferred sets dismissed=1, archived=1, archived_at', () => {
    const { lastInsertRowid: id } = db.insertDeferred.run({
      url: 'https://y.com', title: 'Y', favicon_url: null, source_mission: null,
    });

    db.dismissDeferred.run({ id });

    const row = db.db.prepare('SELECT * FROM deferred_tabs WHERE id = ?').get(id);
    expect(row.dismissed).toBe(1);
    expect(row.archived).toBe(1);
    expect(row.archived_at).toBeTruthy();
    expect(row.checked).toBe(0);
  });

  it('ageOutDeferred archives rows older than 30 days', () => {
    db.db.prepare(`
      INSERT INTO deferred_tabs (url, title, deferred_at, archived)
      VALUES ('https://old.com', 'Old', datetime('now', '-31 days'), 0)
    `).run();

    db.ageOutDeferred.run();

    const row = db.db.prepare('SELECT * FROM deferred_tabs WHERE url = ?').get('https://old.com');
    expect(row.archived).toBe(1);
    expect(row.archived_at).toBeTruthy();
  });

  it('ageOutDeferred does NOT archive rows <30 days old', () => {
    db.db.prepare(`
      INSERT INTO deferred_tabs (url, title, deferred_at, archived)
      VALUES ('https://fresh.com', 'Fresh', datetime('now', '-29 days'), 0)
    `).run();

    db.ageOutDeferred.run();

    const row = db.db.prepare('SELECT * FROM deferred_tabs WHERE url = ?').get('https://fresh.com');
    expect(row.archived).toBe(0);
    expect(row.archived_at).toBeNull();
  });

  it('searchDeferredArchived matches title LIKE %q%', () => {
    insertDeferredRaw({ url: 'https://a.com', title: 'React Hooks Guide', deferred_at: '2026-04-01 10:00:00', archived: 1, archived_at: '2026-04-05 10:00:00' });
    insertDeferredRaw({ url: 'https://b.com', title: 'Vue composition API', deferred_at: '2026-04-02 10:00:00', archived: 1, archived_at: '2026-04-06 10:00:00' });

    const results = db.searchDeferredArchived.all({ q: 'React' });
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://a.com');
  });

  it('searchDeferredArchived matches url LIKE %q%', () => {
    insertDeferredRaw({ url: 'https://github.com/foo', title: 'Foo', deferred_at: '2026-04-01 10:00:00', archived: 1, archived_at: '2026-04-05 10:00:00' });
    insertDeferredRaw({ url: 'https://gitlab.com/bar', title: 'Bar', deferred_at: '2026-04-02 10:00:00', archived: 1, archived_at: '2026-04-06 10:00:00' });

    const results = db.searchDeferredArchived.all({ q: 'github' });
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://github.com/foo');
  });

  it('searchDeferredArchived limit 50', () => {
    const insertOne = db.db.prepare(`
      INSERT INTO deferred_tabs (url, title, deferred_at, archived, archived_at)
      VALUES (?, ?, ?, 1, ?)
    `);
    for (let i = 0; i < 60; i++) {
      insertOne.run(`https://example.com/${i}`, `Example ${i}`, `2026-04-01 10:00:${String(i).padStart(2, '0')}`, `2026-04-05 10:00:${String(i).padStart(2, '0')}`);
    }

    const results = db.searchDeferredArchived.all({ q: 'Example' });
    expect(results).toHaveLength(50);
  });

  it('searchDeferredArchived excludes non-archived rows', () => {
    insertDeferredRaw({ url: 'https://active.com', title: 'Active React', deferred_at: '2026-04-01 10:00:00', archived: 0 });
    insertDeferredRaw({ url: 'https://archived.com', title: 'Archived React', deferred_at: '2026-04-02 10:00:00', archived: 1, archived_at: '2026-04-06 10:00:00' });

    const results = db.searchDeferredArchived.all({ q: 'React' });
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://archived.com');
  });
});

describe('missions prepared statements', () => {
  function insertMission({ id, name, status = 'active', last_activity = '2026-04-10 10:00:00', dismissed = 0 }) {
    db.upsertMission.run({
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

  it('getMissions excludes dismissed=1 rows', () => {
    insertMission({ id: 'm1', name: 'Active Mission' });
    insertMission({ id: 'm2', name: 'Dismissed Mission', dismissed: 1 });

    const rows = db.getMissions.all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('m1');
  });

  it('getMissions orders by status priority then recency', () => {
    insertMission({ id: 'ab1', name: 'Abandoned Newer', status: 'abandoned', last_activity: '2026-04-15 10:00:00' });
    insertMission({ id: 'ac1', name: 'Active Older', status: 'active', last_activity: '2026-04-01 10:00:00' });
    insertMission({ id: 'co1', name: 'Cooling Middle', status: 'cooling', last_activity: '2026-04-05 10:00:00' });
    insertMission({ id: 'ac2', name: 'Active Newer', status: 'active', last_activity: '2026-04-10 10:00:00' });

    const rows = db.getMissions.all();
    expect(rows.map(r => r.id)).toEqual(['ac2', 'ac1', 'co1', 'ab1']);
  });

  it('dismissMission sets dismissed=1', () => {
    insertMission({ id: 'm1', name: 'To dismiss' });
    db.dismissMission.run({ id: 'm1' });

    const row = db.db.prepare('SELECT * FROM missions WHERE id = ?').get('m1');
    expect(row.dismissed).toBe(1);
  });

  it('archiveMission inserts into archives table with urls_json', () => {
    db.archiveMission.run({
      mission_id: 'm1',
      mission_name: 'Trip Planning',
      urls_json: JSON.stringify([{ url: 'https://a.com', title: 'A' }]),
      archived_at: '2026-04-14T12:00:00Z',
    });

    const row = db.db.prepare('SELECT * FROM archives WHERE mission_id = ?').get('m1');
    expect(row.mission_name).toBe('Trip Planning');
    expect(JSON.parse(row.urls_json)).toEqual([{ url: 'https://a.com', title: 'A' }]);
    expect(row.archived_at).toBe('2026-04-14T12:00:00Z');
  });

  it('clearAllMissions transaction deletes missions + mission_urls atomically', () => {
    insertMission({ id: 'm1', name: 'Mission 1' });
    insertMission({ id: 'm2', name: 'Mission 2' });
    db.insertMissionUrl.run({
      mission_id: 'm1', url: 'https://a.com', title: 'A', visit_count: 1, last_visit: '2026-04-10 10:00:00',
    });
    db.insertMissionUrl.run({
      mission_id: 'm2', url: 'https://b.com', title: 'B', visit_count: 1, last_visit: '2026-04-10 10:00:00',
    });

    db.clearAllMissions();

    const missions = db.db.prepare('SELECT * FROM missions').all();
    const urls = db.db.prepare('SELECT * FROM mission_urls').all();
    expect(missions).toHaveLength(0);
    expect(urls).toHaveLength(0);
  });
});

describe('meta prepared statements', () => {
  it('setMeta inserts a new key', () => {
    db.setMeta.run({ key: 'last_analysis', value: '2026-04-14T10:00:00Z' });
    const row = db.getMeta.get({ key: 'last_analysis' });
    expect(row.value).toBe('2026-04-14T10:00:00Z');
  });

  it('setMeta replaces an existing key', () => {
    db.setMeta.run({ key: 'last_analysis', value: 'v1' });
    db.setMeta.run({ key: 'last_analysis', value: 'v2' });
    const row = db.getMeta.get({ key: 'last_analysis' });
    expect(row.value).toBe('v2');
  });

  it('getMeta returns undefined for missing key', () => {
    const row = db.getMeta.get({ key: 'nonexistent' });
    expect(row).toBeUndefined();
  });
});
