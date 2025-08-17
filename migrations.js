import { readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(pool) {
  // Create migrations table to track applied migrations
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Get list of migration files
  const migrationsDir = join(__dirname, 'migrations');
  const files = await readdir(migrationsDir);
  const migrationFiles = files
    .filter(f => f.endsWith('.js'))
    .sort(); // Sort to ensure order
  
  console.log(`Found ${migrationFiles.length} migration files`);
  
  // Check which migrations have been applied
  const appliedResult = await pool.query('SELECT id FROM migrations');
  const applied = new Set(appliedResult.rows.map(r => r.id));
  
  // Run pending migrations
  let migrationsRun = 0;
  for (const file of migrationFiles) {
    const migrationId = file.replace('.js', '');
    
    if (applied.has(migrationId)) {
      console.log(`Migration ${migrationId} already applied, skipping`);
      continue;
    }
    
    console.log(`Running migration: ${migrationId}`);
    
    try {
      // Import and run the migration
      const migration = await import(join(migrationsDir, file));
      
      // Start transaction
      await pool.query('BEGIN');
      
      try {
        // Run the up migration
        await migration.up(pool);
        
        // Record that this migration has been applied
        await pool.query(
          'INSERT INTO migrations (id) VALUES ($1)',
          [migrationId]
        );
        
        // Commit transaction
        await pool.query('COMMIT');
        
        console.log(`Migration ${migrationId} completed successfully`);
        migrationsRun++;
      } catch (error) {
        // Rollback on error
        await pool.query('ROLLBACK');
        throw error;
      }
    } catch (error) {
      console.error(`Failed to run migration ${migrationId}:`, error);
      throw new Error(`Migration ${migrationId} failed: ${error.message}`);
    }
  }
  
  if (migrationsRun > 0) {
    console.log(`Successfully ran ${migrationsRun} migrations`);
  } else {
    console.log('All migrations already applied');
  }
  
  return migrationsRun;
}

export async function rollbackMigration(pool, migrationId = null) {
  // Get the last applied migration if no specific one provided
  if (!migrationId) {
    const result = await pool.query(
      'SELECT id FROM migrations ORDER BY applied_at DESC LIMIT 1'
    );
    
    if (result.rows.length === 0) {
      console.log('No migrations to rollback');
      return null;
    }
    
    migrationId = result.rows[0].id;
  }
  
  console.log(`Rolling back migration: ${migrationId}`);
  
  try {
    // Import the migration
    const migration = await import(join(__dirname, 'migrations', `${migrationId}.js`));
    
    if (!migration.down) {
      throw new Error(`Migration ${migrationId} does not have a down method`);
    }
    
    // Start transaction
    await pool.query('BEGIN');
    
    try {
      // Run the down migration
      await migration.down(pool);
      
      // Remove from migrations table
      await pool.query('DELETE FROM migrations WHERE id = $1', [migrationId]);
      
      // Commit transaction
      await pool.query('COMMIT');
      
      console.log(`Migration ${migrationId} rolled back successfully`);
      return migrationId;
    } catch (error) {
      // Rollback on error
      await pool.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error(`Failed to rollback migration ${migrationId}:`, error);
    throw new Error(`Rollback of ${migrationId} failed: ${error.message}`);
  }
}

export async function getMigrationStatus(pool) {
  try {
    // Check if migrations table exists
    const tableExists = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'migrations'
      )
    `);
    
    if (!tableExists.rows[0].exists) {
      return {
        initialized: false,
        applied: [],
        pending: []
      };
    }
    
    // Get applied migrations
    const appliedResult = await pool.query(
      'SELECT id, applied_at FROM migrations ORDER BY applied_at'
    );
    
    // Get list of all migration files
    const migrationsDir = join(__dirname, 'migrations');
    const files = await readdir(migrationsDir);
    const allMigrations = files
      .filter(f => f.endsWith('.js'))
      .map(f => f.replace('.js', ''))
      .sort();
    
    const appliedIds = new Set(appliedResult.rows.map(r => r.id));
    const pending = allMigrations.filter(id => !appliedIds.has(id));
    
    return {
      initialized: true,
      applied: appliedResult.rows,
      pending
    };
  } catch (error) {
    console.error('Error getting migration status:', error);
    return {
      initialized: false,
      error: error.message
    };
  }
}