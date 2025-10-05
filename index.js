const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

/**
 * PostGIS OSM Database Adapter
 * Provides unified access patterns to PostGIS databases with OSM data
 * Supports facade patterns for hierarchical admin area access
 */
class PostGISAdapter {
  /**
   * Create a new PostGIS adapter
   * @param {Object} config - Database connection configuration (optional if using config file)
   * @param {string} config.host - Database host
   * @param {number} config.port - Database port (default: 5432)
   * @param {string} config.database - Database name
   * @param {string} config.user - Database user
   * @param {string} config.password - Database password
   * @param {string} config.schema - Database schema (default: 'public')
   * @param {string} configPath - Path to config file (optional)
   */
  constructor(config = null, configPath = null) {
    // Load config from file if provided, otherwise use passed config
    let finalConfig = config;
    
    if (configPath) {
      finalConfig = this.loadConfigFromFile(configPath);
    } else if (!config) {
      // Try to load from default location
      const defaultConfigPath = path.join(process.cwd(), 'config', 'config.json');
      if (fs.existsSync(defaultConfigPath)) {
        finalConfig = this.loadConfigFromFile(defaultConfigPath);
      } else {
        throw new Error('No configuration provided. Either pass config object or create config/config.json');
      }
    }

    this.pool = new Pool({
      host: finalConfig.host || 'localhost',
      port: finalConfig.port || 5432,
      database: finalConfig.database,
      user: finalConfig.user,
      password: finalConfig.password,
    });

    this.schema = finalConfig.schema || 'public';
    this.metadata = {
      tables: null,
      views: null,
      columns: null,
    };
    
    // Cache for admin area queries
    this.adminAreaCache = {
      countries: null,
      adminLevels: {},
    };
  }

  /**
   * Load configuration from JSON file
   * @param {string} filePath - Path to config file
   * @returns {Object} Configuration object
   */
  loadConfigFromFile(filePath) {
    try {
      const configData = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(configData);
    } catch (error) {
      throw new Error(`Failed to load config from ${filePath}: ${error.message}`);
    }
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
    // Return cached data if available
    if (this.adminAreaCache.countries) {
      return this.adminAreaCache.countries;
    }

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
          const geomColumn = this.findGeometryColumn(table.table_name);
          const query = `
            SELECT 
              osm_id,
              name,
              admin_level,
              boundary,
              ST_Area(${geomColumn}::geography) / 1000000 as area_sq_km,
              ST_Area(${geomColumn}::geography) as area_sq_meters
            FROM ${this.schema}.${table.table_name}
            WHERE admin_level = '2'
              AND boundary = 'administrative'
              AND name IS NOT NULL
            ORDER BY area_sq_km DESC;
          `;

          const result = await this.pool.query(query);
          
          if (result.rows.length > 0) {
            this.adminAreaCache.countries = result.rows;
            return result.rows;
          }
        } catch (error) {
          // Try alternative approach
          try {
            const query = `
              SELECT 
                osm_id,
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
              this.adminAreaCache.countries = result.rows;
              return result.rows;
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
   * Find the geometry column name for a table
   * @param {string} tableName - Name of the table
   * @returns {string} Geometry column name
   */
  findGeometryColumn(tableName) {
    const columns = this.getTableColumns(tableName);
    const geomColumn = columns.find(c => 
      c.data_type === 'USER-DEFINED' && 
      (c.udt_name === 'geometry' || c.udt_name === 'geography')
    );
    return geomColumn ? geomColumn.column_name : 'way';
  }

  /**
   * Get admin areas by level
   * @param {string} adminLevel - OSM admin level (e.g., '2' for countries, '4' for states/provinces)
   * @returns {Array} Admin areas at the specified level
   */
  async getAdminAreasByLevel(adminLevel) {
    const cacheKey = `level_${adminLevel}`;
    if (this.adminAreaCache.adminLevels[cacheKey]) {
      return this.adminAreaCache.adminLevels[cacheKey];
    }

    const osmTables = this.findOSMTables();
    const polygonTables = osmTables.filter(t => 
      t.table_name.includes('polygon') || t.table_name.includes('boundaries')
    );

    if (polygonTables.length === 0) {
      throw new Error('No suitable polygon tables found');
    }

    for (const table of polygonTables) {
      const columns = this.getTableColumns(table.table_name);
      const hasAdminLevel = columns.some(c => c.column_name === 'admin_level');
      
      if (hasAdminLevel) {
        try {
          const geomColumn = this.findGeometryColumn(table.table_name);
          const query = `
            SELECT 
              osm_id,
              name,
              admin_level,
              boundary,
              ST_Area(${geomColumn}::geography) / 1000000 as area_sq_km,
              ST_Area(${geomColumn}::geography) as area_sq_meters
            FROM ${this.schema}.${table.table_name}
            WHERE admin_level = $1
              AND boundary = 'administrative'
              AND name IS NOT NULL
            ORDER BY area_sq_km DESC;
          `;

          const result = await this.pool.query(query, [adminLevel]);
          
          if (result.rows.length > 0) {
            this.adminAreaCache.adminLevels[cacheKey] = result.rows;
            return result.rows;
          }
        } catch (error) {
          // Try next table
        }
      }
    }

    return [];
  }

  /**
   * Get admin areas within a specific country
   * @param {string} countryName - Name of the country
   * @param {string} adminLevel - OSM admin level (e.g., '4' for states/provinces, '6' for counties)
   * @returns {Array} Admin areas within the country
   */
  async getAdminAreasInCountry(countryName, adminLevel) {
    const osmTables = this.findOSMTables();
    const polygonTables = osmTables.filter(t => 
      t.table_name.includes('polygon') || t.table_name.includes('boundaries')
    );

    if (polygonTables.length === 0) {
      throw new Error('No suitable polygon tables found');
    }

    for (const table of polygonTables) {
      const columns = this.getTableColumns(table.table_name);
      const hasAdminLevel = columns.some(c => c.column_name === 'admin_level');
      
      if (hasAdminLevel) {
        try {
          const geomColumn = this.findGeometryColumn(table.table_name);
          
          // First, get the country geometry
          const countryQuery = `
            SELECT ${geomColumn} as country_geom
            FROM ${this.schema}.${table.table_name}
            WHERE admin_level = '2'
              AND boundary = 'administrative'
              AND name = $1
            LIMIT 1;
          `;
          
          const countryResult = await this.pool.query(countryQuery, [countryName]);
          
          if (countryResult.rows.length === 0) {
            throw new Error(`Country '${countryName}' not found`);
          }

          // Then, find admin areas within the country
          const areasQuery = `
            SELECT 
              a.osm_id,
              a.name,
              a.admin_level,
              a.boundary,
              ST_Area(a.${geomColumn}::geography) / 1000000 as area_sq_km,
              ST_Area(a.${geomColumn}::geography) as area_sq_meters
            FROM ${this.schema}.${table.table_name} a,
                 (SELECT ${geomColumn} as country_geom 
                  FROM ${this.schema}.${table.table_name}
                  WHERE admin_level = '2' 
                    AND boundary = 'administrative'
                    AND name = $1
                  LIMIT 1) c
            WHERE a.admin_level = $2
              AND a.boundary = 'administrative'
              AND a.name IS NOT NULL
              AND ST_Within(ST_Centroid(a.${geomColumn}), c.country_geom)
            ORDER BY a.area_sq_km DESC;
          `;

          const result = await this.pool.query(areasQuery, [countryName, adminLevel]);
          return result.rows;
        } catch (error) {
          // Try next table or throw if it's a specific error
          if (error.message.includes('not found')) {
            throw error;
          }
        }
      }
    }

    return [];
  }

  /**
   * Get hierarchical admin areas for all countries
   * Returns countries with their sub-admin areas organized hierarchically
   * @param {string} subAdminLevel - OSM admin level for sub-areas (e.g., '4' for states/provinces)
   * @returns {Array} Countries with nested admin areas
   */
  async getHierarchicalAdminAreas(subAdminLevel = '4') {
    const countries = await this.getCountries();
    const hierarchical = [];

    for (const country of countries) {
      try {
        const subAreas = await this.getAdminAreasInCountry(country.name, subAdminLevel);
        hierarchical.push({
          ...country,
          subAreas: subAreas,
          subAreaCount: subAreas.length,
        });
      } catch (error) {
        // If we can't get sub-areas for a country, include it without sub-areas
        hierarchical.push({
          ...country,
          subAreas: [],
          subAreaCount: 0,
        });
      }
    }

    return hierarchical;
  }

  /**
   * Get the next admin level down within a country
   * Automatically determines the next level based on what's available
   * @param {string} countryName - Name of the country
   * @returns {Array} Admin areas at the next level down
   */
  async getNextAdminLevelInCountry(countryName) {
    // Common admin level progressions in OSM:
    // 2 = country
    // 3 = sometimes used for regions
    // 4 = state/province
    // 5 = sometimes used
    // 6 = county/district
    // 7 = municipality
    // 8 = city/town
    
    const levelsToTry = ['3', '4', '5', '6'];
    
    for (const level of levelsToTry) {
      try {
        const areas = await this.getAdminAreasInCountry(countryName, level);
        if (areas.length > 0) {
          return {
            adminLevel: level,
            areas: areas,
          };
        }
      } catch (error) {
        // Continue to next level
      }
    }

    return {
      adminLevel: null,
      areas: [],
    };
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
