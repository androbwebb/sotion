#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';
import { runMigrations, rollbackMigration, getMigrationStatus } from './migrations.js';

const { Pool } = pg;

async function main() {
  const command = process.argv[2];
  
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }
  
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });
  
  try {
    switch (command) {
      case 'up':
      case 'migrate':
        console.log('Running migrations...');
        const migrationsRun = await runMigrations(pool);
        if (migrationsRun > 0) {
          console.log(`✅ Successfully ran ${migrationsRun} migrations`);
        } else {
          console.log('✅ All migrations already applied');
        }
        break;
        
      case 'down':
      case 'rollback':
        const migrationId = process.argv[3];
        console.log('Rolling back migration...');
        const rolled = await rollbackMigration(pool, migrationId);
        if (rolled) {
          console.log(`✅ Successfully rolled back migration: ${rolled}`);
        } else {
          console.log('No migrations to rollback');
        }
        break;
        
      case 'status':
        console.log('Checking migration status...');
        const status = await getMigrationStatus(pool);
        
        if (!status.initialized) {
          console.log('❌ Migrations not initialized');
        } else {
          console.log('\n📊 Migration Status:');
          console.log('==================');
          
          if (status.applied.length > 0) {
            console.log('\n✅ Applied migrations:');
            status.applied.forEach(m => {
              const date = new Date(m.applied_at).toLocaleString();
              console.log(`   - ${m.id} (applied: ${date})`);
            });
          } else {
            console.log('\n No migrations applied yet');
          }
          
          if (status.pending.length > 0) {
            console.log('\n⏳ Pending migrations:');
            status.pending.forEach(m => {
              console.log(`   - ${m}`);
            });
          } else {
            console.log('\n✅ No pending migrations');
          }
        }
        break;
        
      case 'help':
      default:
        console.log(`
Database Migration Tool

Usage: node migrate.js [command] [options]

Commands:
  up, migrate     Run all pending migrations
  down, rollback  Rollback the last migration (or specify migration ID)
  status          Show migration status
  help            Show this help message

Examples:
  node migrate.js up                    # Run all pending migrations
  node migrate.js status                # Check migration status
  node migrate.js rollback              # Rollback last migration
  node migrate.js rollback 001_initial  # Rollback specific migration
        `);
        break;
    }
  } catch (error) {
    console.error('❌ Migration error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});