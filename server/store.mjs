import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

// SQLite serializes separate stdio/HTTP processes too. A crash rolls back
// the transaction, including an incomplete player-and-engine exchange.
export class Store {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(resolve(directory, 'games.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=0;
      CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS position_scores (game_id TEXT NOT NULL, position_key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(game_id,position_key));
      CREATE TABLE IF NOT EXISTS board_lessons (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS board_lessons_game ON board_lessons(game_id);
      CREATE TABLE IF NOT EXISTS game_reviews (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS game_reviews_game ON game_reviews(game_id);
      CREATE TABLE IF NOT EXISTS training_profile (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);`);
    this.queue = Promise.resolve();
  }
  validate(id) { if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('棋局编号无效。'); }
  async load(id) {
    this.validate(id);
    const row = this.db.prepare('SELECT data FROM games WHERE id=?').get(id);
    if (!row) throw new Error('没有找到这盘棋。请读取棋局列表。');
    return JSON.parse(row.data);
  }
  async exists(id) { this.validate(id); return !!this.db.prepare('SELECT id FROM games WHERE id=?').get(id); }
  async save(game) {
    this.validate(game.id);
    this.db.prepare('INSERT INTO games(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(game.id, JSON.stringify(game));
  }
  async serial(id, action) {
    this.validate(id);
    const task = this.queue.then(async () => {
      const deadline = Date.now() + 45000;
      while (true) {
        try { this.db.exec('BEGIN IMMEDIATE'); break; }
        catch (error) {
          if (!error.message.includes('locked') || Date.now() >= deadline) throw new Error('另一个窗口正在保存棋局，请稍后重试。');
          await delay(50);
        }
      }
      try { const result = await action(); this.db.exec('COMMIT'); return result; }
      catch (error) { this.db.exec('ROLLBACK'); throw error; }
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async list() {
    return this.db.prepare('SELECT data FROM games').all().map(row => JSON.parse(row.data))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30)
      .map(({ id, version, mode = 'play', playerSide, updatedAt, status, moves }) => ({ id, version, mode, playerSide, updatedAt, status, plies: moves.length }));
  }
  score(gameId, key) {
    this.validate(gameId);
    const row = this.db.prepare('SELECT data FROM position_scores WHERE game_id=? AND position_key=?').get(gameId, key);
    return row ? JSON.parse(row.data) : null;
  }
  saveScore(gameId, key, point) {
    this.validate(gameId);
    this.db.prepare('INSERT INTO position_scores(game_id,position_key,data) VALUES(?,?,?) ON CONFLICT(game_id,position_key) DO UPDATE SET data=excluded.data').run(gameId, key, JSON.stringify(point));
  }
  lesson(gameId, id) {
    this.validate(gameId);
    const row = this.db.prepare('SELECT data FROM board_lessons WHERE game_id=? AND id=?').get(gameId, id);
    return row ? JSON.parse(row.data) : null;
  }
  saveLesson(lesson) {
    this.validate(lesson.gameId);
    const saved = this.db.prepare('INSERT INTO board_lessons(id,game_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE board_lessons.game_id=excluded.game_id').run(lesson.requestId, lesson.gameId, JSON.stringify(lesson));
    if (!saved.changes) throw new Error('讲解请求编号已用于另一盘棋。');
  }
  lessons(gameId) {
    this.validate(gameId);
    return this.db.prepare('SELECT data FROM board_lessons WHERE game_id=? ORDER BY rowid DESC LIMIT 30').all(gameId).map(row => JSON.parse(row.data));
  }
  review(gameId, id) {
    this.validate(gameId);
    const row = this.db.prepare('SELECT data FROM game_reviews WHERE game_id=? AND id=?').get(gameId, id);
    return row ? JSON.parse(row.data) : null;
  }
  saveReview(review) {
    this.validate(review.gameId);
    this.db.prepare('INSERT INTO game_reviews(id,game_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE game_reviews.game_id=excluded.game_id').run(review.id, review.gameId, JSON.stringify(review));
  }
  reviews(gameId) {
    this.validate(gameId);
    return this.db.prepare('SELECT data FROM game_reviews WHERE game_id=? ORDER BY rowid DESC LIMIT 10').all(gameId).map(row => JSON.parse(row.data));
  }
  trainingProfile() {
    const row = this.db.prepare('SELECT data FROM training_profile WHERE id=1').get();
    return row ? JSON.parse(row.data) : { rating: 1200, attempts: 0, correct: 0, streak: 0, bestStreak: 0, progress: {}, recent: [], challenges: [] };
  }
  pendingChallenges(now) {
    return this.db.prepare(`SELECT id FROM games
      WHERE json_extract(data,'$.training.session.finished') = 0
        AND json_extract(data,'$.training.session.durationSeconds') > 0
        AND json_extract(data,'$.training.session.startedAt') + json_extract(data,'$.training.session.durationSeconds') * 1000 <= ?`)
      .all(now).map(row => row.id);
  }
  saveTrainingProfile(profile) {
    this.db.prepare('INSERT INTO training_profile(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(profile));
  }
  close() { this.db.close(); }
}
