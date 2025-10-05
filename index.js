const { Pool } = require('pg');

/**
 * PostGIS OSM Database Adapter
 * Provides unified access patterns to PostGIS databases with OSM data
 */
class PostGISAdapter {
  /**
   * Create a new PostGIS adapter
   * @param {Object} config - Database connection configuration
   * @param {string} config.host - Database host
   * @param {number} config.port - Database port (default: 5432)
   * @param {string} config.database - Database name
   * @param {string} config.user - Database user
   * @param {string} config.password - Database password
   */
  constructor(config) {
    this.pool = new Pool({
      host: config.host || 'localhost',
      port: config.port || 5432,
      database: config.database,
      user: config.user,
      password: config.password,
    });

    this.schema = config.schema || 'public';
    this.metadata = {
      tables: null,
      views: null,
      columns: null,
    };
  }

  /**
   * Connect to the database and initialize metadata
   */
  async connect() {
    try {
      const client = await this.pool.connect();
      client.release();
      console.log('Connected to PostGIS database');
      await this.introspectDatabase();
      return true;
    } catch (error) {
      console.error('Connection error:', error.message);
      throw error;
    }
  }

  /**
   * Introspect database to discover tables, views, and their structure
   * This helps adapt to different osm2pgsql configurations
   */
  async introspectDatabase() {
    await Promise.all([
      this.discoverTables(),
      this.discoverViews(),
      this.discoverColumns(),
    ]);

    console.log(`Discovered ${this.metadata.tables.length} tables`);
    console.log(`Discovered ${this.metadata.views.length} views`);
    console.log(`Discovered ${this.metadata.columns.length} columns`);
  }

  /**
   * Discover all tables in the schema
   */
  async discoverTables() {
    const query = `
      SELECT 
        table_name,
        table_type,
        (pg_relation_size('"' || table_schema || '"."' || table_name || '"')) as size_bytes
      FROM information_schema.tables
      WHERE table_schema = $1
        AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `;

    const result = await this.pool.query(query, [this.schema]);
    this.metadata.tables = result.rows;
    return result.rows;
  }

  /**
   * Discover all views in the schema
   */
  async discoverViews() {
    const query = `
      SELECT 
        table_name as view_name,
        view_definition
      FROM information_schema.views
      WHERE table_schema = $1
      ORDER BY table_name;
    `;

    const result = await this.pool.query(query, [this.schema]);
    this.metadata.views = result.rows;
    return result.rows;
  }

  /**
   * Discover all columns in all tables and views
   */
  async discoverColumns() {
    const query = `
      SELECT 
        table_name,
        column_name,
        data_type,
        udt_name,
        is_nullable,
        column_default,
        ordinal_position
      FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_name, ordinal_position;
    `;

    const result = await this.pool.query(query, [this.schema]);
    this.metadata.columns = result.rows;
    return result.rows;
  }

  /**
   * Get metadata for a specific table
   * @param {string} tableName - Name of the table
   */
  getTableMetadata(tableName) {
    if (!this.metadata.tables) {
      throw new Error('Database not introspected yet. Call connect() first.');
    }

    const table = this.metadata.tables.find(t => t.table_name === tableName);
    if (!table) {
      return null;
    }

    const columns = this.metadata.columns.filter(c => c.table_name === tableName);
    
    return {
      ...table,
      columns: columns,
    };
  }

  /**
   * Get list of all tables
   */
  getTables() {
    if (!this.metadata.tables) {
      throw new Error('Database not introspected yet. Call connect() first.');
    }
    return this.metadata.tables;
  }

  /**
   * Get list of all views
   */
  getViews() {
    if (!this.metadata.views) {
      throw new Error('Database not introspected yet. Call connect() first.');
    }
    return this.metadata.views;
  }

  /**
   * Get columns for a specific table
   * @param {string} tableName - Name of the table
   */
  getTableColumns(tableName) {
    if (!this.metadata.columns) {
      throw new Error('Database not introspected yet. Call connect() first.');
    }
    return this.metadata.columns.filter(c => c.table_name === tableName);
  }

  /**
   * Find OSM tables based on common naming patterns
   * osm2pgsql typically creates tables like: planet_osm_point, planet_osm_line, planet_osm_polygon, planet_osm_roads
   */
  findOSMTables() {
    if (!this.metadata.tables) {
      throw new Error('Database not introspected yet. Call connect() first.');
    }

    const osmPatterns = [
      /^planet_osm_/,
      /_osm_/,
      /^osm_/,
    ];

    return this.metadata.tables.filter(table => {
      return osmPatterns.some(pattern => pattern.test(table.table_name));
    });
  }

  /**
   * Get list of all countries from the database with calculated areas
   * This looks for country data in common OSM tables and calculates area using PostGIS
   */
  async getCountries() {
    // First, try to find a suitable table that contains country boundaries
    const osmTables = this.findOSMTables();
    
    // Look for polygon tables which typically contain country boundaries
    const polygonTables = osmTables.filter(t => 
      t.table_name.includes('polygon') || t.table_name.includes('boundaries')
    );

    if (polygonTables.length === 0) {
      throw new Error('No suitable polygon tables found for country boundaries');
    }

    // Try each table to find one with country data
    for (const table of polygonTables) {
      const columns = this.getTableColumns(table.table_name);
      
      // Check if table has necessary columns for countries
      const hasNameColumn = columns.some(c => c.column_name === 'name');
      const hasAdminLevel = columns.some(c => c.column_name === 'admin_level');
      const hasBoundary = columns.some(c => c.column_name === 'boundary');
      const hasGeometry = columns.some(c => c.data_type === 'USER-DEFINED' && 
        (c.udt_name === 'geometry' || c.udt_name === 'geography'));

      if (hasNameColumn && hasGeometry && (hasAdminLevel || hasBoundary)) {
        try {
          // admin_level = '2' indicates country boundaries in OSM
          const query = `
            SELECT 
              name,
              admin_level,
              boundary,
              ST_Area(way::geography) / 1000000 as area_sq_km,
              ST_Area(way::geography) as area_sq_meters
            FROM ${this.schema}.${table.table_name}
            WHERE admin_level = '2'
              AND boundary = 'administrative'
              AND name IS NOT NULL
            ORDER BY area_sq_km DESC;
          `;

          const result = await this.pool.query(query);
          
          if (result.rows.length > 0) {
            return result.rows;
          }
        } catch (error) {
          // Try alternative column names
          try {
            // Some tables might use 'geom' instead of 'way'
            const geomColumn = columns.find(c => 
              c.data_type === 'USER-DEFINED' && 
              (c.udt_name === 'geometry' || c.udt_name === 'geography')
            );

            if (geomColumn) {
              const query = `
                SELECT 
                  name,
                  admin_level,
                  boundary,
                  ST_Area(${geomColumn.column_name}::geography) / 1000000 as area_sq_km,
                  ST_Area(${geomColumn.column_name}::geography) as area_sq_meters
                FROM ${this.schema}.${table.table_name}
                WHERE admin_level = '2'
                  AND boundary = 'administrative'
                  AND name IS NOT NULL
                ORDER BY area_sq_km DESC;
              `;

              const result = await this.pool.query(query);
              
              if (result.rows.length > 0) {
                return result.rows;
              }
            }
          } catch (err) {
            // Continue to next table
          }
        }
      }
    }

    throw new Error('No country data found in available tables');
  }

  /**
   * Execute a raw SQL query
   * @param {string} query - SQL query to execute
   * @param {Array} params - Query parameters
   */
  async query(query, params = []) {
    return await this.pool.query(query, params);
  }

  /**
   * Close the database connection
   */
  async close() {
    await this.pool.end();
    console.log('Database connection closed');
  }
}

module.exports = PostGISAdapter;
