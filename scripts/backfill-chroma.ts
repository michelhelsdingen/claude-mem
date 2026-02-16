#!/usr/bin/env bun
/**
 * Chroma Backfill Script
 *
 * Re-embeds all historical observations from SQLite into Chroma vector-db.
 * Run after a vector-db reset or fresh install.
 *
 * Usage: bun scripts/backfill-chroma.ts [--project <name>]
 *   No args: backfills all projects
 *   --project <name>: backfill a single project
 */

import { ChromaSync } from '../src/services/sync/ChromaSync.js';
import { ChromaServerManager } from '../src/services/sync/ChromaServerManager.js';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  const args = process.argv.slice(2);
  const projectIndex = args.indexOf('--project');
  const singleProject = projectIndex >= 0 ? args[projectIndex + 1] : null;

  console.log('=== Chroma Backfill ===\n');

  // Ensure Chroma server is running
  const serverManager = ChromaServerManager.getInstance();
  console.log('Checking Chroma server...');

  const reachable = await serverManager.isServerReachable();
  if (!reachable) {
    console.log('Starting Chroma server...');
    await serverManager.start();
    // Wait for server to be ready
    for (let i = 0; i < 30; i++) {
      if (await serverManager.isServerReachable()) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!await serverManager.isServerReachable()) {
      console.error('ERROR: Could not start Chroma server');
      process.exit(1);
    }
  }
  console.log('Chroma server is running.\n');

  // Get list of projects
  const db = new SessionStore();
  let projects: string[];

  if (singleProject) {
    projects = [singleProject];
  } else {
    const rows = db.db.prepare(`
      SELECT project, COUNT(*) as cnt
      FROM observations
      WHERE project IS NOT NULL AND project != ''
      GROUP BY project
      ORDER BY cnt DESC
    `).all() as { project: string; cnt: number }[];

    projects = rows.map(r => r.project);
    console.log(`Found ${projects.length} projects with ${rows.reduce((a, r) => a + r.cnt, 0)} total observations\n`);

    for (const row of rows) {
      console.log(`  ${row.project}: ${row.cnt} observations`);
    }
    console.log();
  }

  db.close();

  // Backfill each project
  let totalSuccess = 0;
  let totalFailed = 0;

  for (const project of projects) {
    console.log(`\n--- Backfilling: ${project} ---`);
    const chromaSync = new ChromaSync(project);

    try {
      await chromaSync.ensureBackfilled();
      console.log(`  ✓ ${project} complete`);
      totalSuccess++;
    } catch (error) {
      console.error(`  ✗ ${project} failed: ${error instanceof Error ? error.message : String(error)}`);
      totalFailed++;
    } finally {
      await chromaSync.close();
    }
  }

  console.log(`\n=== Backfill Summary ===`);
  console.log(`  Success: ${totalSuccess}/${projects.length}`);
  if (totalFailed > 0) {
    console.log(`  Failed: ${totalFailed}/${projects.length}`);
  }
  console.log();

  // Shutdown server manager (don't kill the server itself)
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
