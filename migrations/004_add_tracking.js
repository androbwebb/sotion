export const up = async (pool) => {
  // Create tracking table for email and page analytics
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracking (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      type VARCHAR(10) NOT NULL CHECK (type IN ('email', 'page')),
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      user_agent TEXT,
      ip VARCHAR(45),
      referer TEXT,
      page_id VARCHAR(10),
      FOREIGN KEY (page_id) REFERENCES url_mappings(id) ON DELETE CASCADE
    )
  `);
  
  // Create indexes for better query performance
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tracking_name ON tracking(name);
    CREATE INDEX IF NOT EXISTS idx_tracking_type ON tracking(type);
    CREATE INDEX IF NOT EXISTS idx_tracking_timestamp ON tracking(timestamp);
  `);
};

export const down = async (pool) => {
  await pool.query('DROP INDEX IF EXISTS idx_tracking_timestamp');
  await pool.query('DROP INDEX IF EXISTS idx_tracking_type');
  await pool.query('DROP INDEX IF EXISTS idx_tracking_name');
  await pool.query('DROP TABLE IF EXISTS tracking');
};