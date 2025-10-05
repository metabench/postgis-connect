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
      indexes: null,
      constraints: null,
    };
    
    // Enhanced schema analysis
    this.schemaAnalysis = {
      osmTableMapping: null,
      geometryColumns: {},
      adminLevelDistribution: {},
      availableAdminLevels: [],
      recommendedTables: {},
    };
    
    // Cache for admin area queries
    this.adminAreaCache = {
      countries: null,
      adminLevels: {},
      euCountries: null,
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
      this.discoverIndexes(),
      this.discoverConstraints(),
    ]);

    console.log(`Discovered ${this.metadata.tables.length} tables`);
    console.log(`Discovered ${this.metadata.views.length} views`);
    console.log(`Discovered ${this.metadata.columns.length} columns`);
    console.log(`Discovered ${this.metadata.indexes?.length || 0} indexes`);
    console.log(`Discovered ${this.metadata.constraints?.length || 0} constraints`);
    
    // Perform comprehensive schema analysis
    await this.analyzeSchema();
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
   * Discover all indexes in the schema
   */
  async discoverIndexes() {
    const query = `
      SELECT
        t.relname as table_name,
        i.relname as index_name,
        a.attname as column_name,
        ix.indisunique as is_unique,
        ix.indisprimary as is_primary
      FROM pg_class t
      JOIN pg_index ix ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1
      ORDER BY t.relname, i.relname;
    `;

    try {
      const result = await this.pool.query(query, [this.schema]);
      this.metadata.indexes = result.rows;
      return result.rows;
    } catch (error) {
      console.warn('Could not discover indexes:', error.message);
      this.metadata.indexes = [];
      return [];
    }
  }

  /**
   * Discover constraints in the schema
   */
  async discoverConstraints() {
    const query = `
      SELECT
        tc.table_name,
        tc.constraint_name,
        tc.constraint_type,
        kcu.column_name
      FROM information_schema.table_constraints tc
      LEFT JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = $1
      ORDER BY tc.table_name, tc.constraint_name;
    `;

    try {
      const result = await this.pool.query(query, [this.schema]);
      this.metadata.constraints = result.rows;
      return result.rows;
    } catch (error) {
      console.warn('Could not discover constraints:', error.message);
      this.metadata.constraints = [];
      return [];
    }
  }

  /**
   * Perform comprehensive schema analysis
   * Analyzes the discovered schema and maps it to OSM expectations
   */
  async analyzeSchema() {
    console.log('\n=== Analyzing Schema ===');
    
    // Identify OSM tables and their purposes
    this.analyzeOSMTables();
    
    // Analyze geometry columns
    this.analyzeGeometryColumns();
    
    // Analyze admin level distribution
    await this.analyzeAdminLevels();
    
    // Generate recommendations
    this.generateRecommendations();
    
    console.log('Schema analysis complete\n');
  }

  /**
   * Analyze OSM tables and map them to their purposes
   */
  analyzeOSMTables() {
    const osmTables = this.findOSMTables();
    
    this.schemaAnalysis.osmTableMapping = {
      point: osmTables.filter(t => t.table_name.includes('point')),
      line: osmTables.filter(t => t.table_name.includes('line') || t.table_name.includes('road')),
      polygon: osmTables.filter(t => t.table_name.includes('polygon')),
      boundaries: osmTables.filter(t => t.table_name.includes('boundaries')),
      other: osmTables.filter(t => 
        !t.table_name.includes('point') && 
        !t.table_name.includes('line') && 
        !t.table_name.includes('road') &&
        !t.table_name.includes('polygon') &&
        !t.table_name.includes('boundaries')
      ),
    };
    
    console.log(`Identified ${osmTables.length} OSM tables:`);
    console.log(`  - Point tables: ${this.schemaAnalysis.osmTableMapping.point.length}`);
    console.log(`  - Line/Road tables: ${this.schemaAnalysis.osmTableMapping.line.length}`);
    console.log(`  - Polygon tables: ${this.schemaAnalysis.osmTableMapping.polygon.length}`);
    console.log(`  - Boundary tables: ${this.schemaAnalysis.osmTableMapping.boundaries.length}`);
    console.log(`  - Other OSM tables: ${this.schemaAnalysis.osmTableMapping.other.length}`);
  }

  /**
   * Analyze geometry columns across all tables
   */
  analyzeGeometryColumns() {
    const geometryTables = {};
    
    this.metadata.tables.forEach(table => {
      const columns = this.getTableColumns(table.table_name);
      const geomColumns = columns.filter(c => 
        c.data_type === 'USER-DEFINED' && 
        (c.udt_name === 'geometry' || c.udt_name === 'geography')
      );
      
      if (geomColumns.length > 0) {
        geometryTables[table.table_name] = geomColumns.map(c => ({
          column: c.column_name,
          type: c.udt_name,
        }));
      }
    });
    
    this.schemaAnalysis.geometryColumns = geometryTables;
    console.log(`Found geometry columns in ${Object.keys(geometryTables).length} tables`);
  }

  /**
   * Analyze admin level distribution in the database
   */
  async analyzeAdminLevels() {
    const polygonTables = [
      ...this.schemaAnalysis.osmTableMapping.polygon,
      ...this.schemaAnalysis.osmTableMapping.boundaries,
    ];
    
    const adminLevelData = {};
    
    for (const table of polygonTables) {
      const columns = this.getTableColumns(table.table_name);
      const hasAdminLevel = columns.some(c => c.column_name === 'admin_level');
      
      if (hasAdminLevel) {
        try {
          const query = `
            SELECT 
              admin_level,
              COUNT(*) as count
            FROM ${this.schema}.${table.table_name}
            WHERE admin_level IS NOT NULL
              AND boundary = 'administrative'
            GROUP BY admin_level
            ORDER BY admin_level::int;
          `;
          
          const result = await this.pool.query(query);
          
          if (result.rows.length > 0) {
            adminLevelData[table.table_name] = result.rows;
            
            // Track all available admin levels
            result.rows.forEach(row => {
              if (!this.schemaAnalysis.availableAdminLevels.includes(row.admin_level)) {
                this.schemaAnalysis.availableAdminLevels.push(row.admin_level);
              }
            });
          }
        } catch (error) {
          // Skip tables that don't support this query
        }
      }
    }
    
    this.schemaAnalysis.adminLevelDistribution = adminLevelData;
    this.schemaAnalysis.availableAdminLevels.sort((a, b) => parseInt(a) - parseInt(b));
    
    console.log(`Available admin levels: ${this.schemaAnalysis.availableAdminLevels.join(', ')}`);
  }

  /**
   * Generate recommendations for optimal data access
   */
  generateRecommendations() {
    const recommendations = {};
    
    // Recommend best table for admin boundaries
    const polygonTables = this.schemaAnalysis.osmTableMapping.polygon;
    if (polygonTables.length > 0) {
      // Prefer tables with more comprehensive data
      const bestTable = polygonTables.reduce((best, current) => {
        const currentColumns = this.getTableColumns(current.table_name);
        const bestColumns = best ? this.getTableColumns(best.table_name) : [];
        return currentColumns.length > bestColumns.length ? current : best;
      }, null);
      
      recommendations.adminBoundaries = bestTable?.table_name;
    }
    
    // Recommend tables for different geometry types
    recommendations.points = this.schemaAnalysis.osmTableMapping.point[0]?.table_name;
    recommendations.lines = this.schemaAnalysis.osmTableMapping.line[0]?.table_name;
    recommendations.polygons = this.schemaAnalysis.osmTableMapping.polygon[0]?.table_name;
    
    this.schemaAnalysis.recommendedTables = recommendations;
    console.log('Recommended tables for common queries:', recommendations);
  }

  /**
   * Get detailed schema analysis report
   * @returns {Object} Comprehensive schema analysis
   */
  getSchemaAnalysis() {
    return {
      metadata: this.metadata,
      analysis: this.schemaAnalysis,
    };
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
   * Get three-level hierarchical admin areas starting with countries
   * Returns countries -> first sub-level -> second sub-level
   * @param {number} limit - Maximum number of countries to process (default: all)
   * @returns {Array} Three-level hierarchical structure
   */
  async getThreeLevelHierarchy(limit = null) {
    const countries = await this.getCountries();
    const countriesToProcess = limit ? countries.slice(0, limit) : countries;
    
    const hierarchy = [];
    
    for (const country of countriesToProcess) {
      try {
        // Get first level down (usually level 3 or 4)
        const level1 = await this.getNextAdminLevelInCountry(country.name);
        
        if (level1.areas.length > 0) {
          // For each first-level area, get the next level down
          const level1WithSubAreas = [];
          
          for (const area1 of level1.areas) {
            try {
              // Get second level down
              const level2 = await this.getAdminAreasWithin(area1.osm_id, country.name);
              
              level1WithSubAreas.push({
                ...area1,
                subAreas: level2,
                subAreaCount: level2.length,
              });
            } catch (error) {
              // If we can't get sub-areas, include without them
              level1WithSubAreas.push({
                ...area1,
                subAreas: [],
                subAreaCount: 0,
              });
            }
          }
          
          hierarchy.push({
            country: {
              osm_id: country.osm_id,
              name: country.name,
              admin_level: country.admin_level,
              area_sq_km: country.area_sq_km,
            },
            level1AdminLevel: level1.adminLevel,
            level1Areas: level1WithSubAreas,
            level1Count: level1WithSubAreas.length,
          });
        } else {
          // Country with no sub-areas
          hierarchy.push({
            country: {
              osm_id: country.osm_id,
              name: country.name,
              admin_level: country.admin_level,
              area_sq_km: country.area_sq_km,
            },
            level1AdminLevel: null,
            level1Areas: [],
            level1Count: 0,
          });
        }
      } catch (error) {
        console.warn(`Could not build hierarchy for ${country.name}:`, error.message);
      }
    }
    
    return hierarchy;
  }

  /**
   * Get admin areas within a parent area by OSM ID
   * @param {number} parentOsmId - OSM ID of the parent area
   * @param {string} countryName - Name of the country (for optimization)
   * @returns {Array} Admin areas within the parent
   */
  async getAdminAreasWithin(parentOsmId, countryName) {
    const osmTables = this.findOSMTables();
    const polygonTables = osmTables.filter(t => 
      t.table_name.includes('polygon') || t.table_name.includes('boundaries')
    );

    if (polygonTables.length === 0) {
      return [];
    }

    for (const table of polygonTables) {
      const columns = this.getTableColumns(table.table_name);
      const hasAdminLevel = columns.some(c => c.column_name === 'admin_level');
      
      if (hasAdminLevel) {
        try {
          const geomColumn = this.findGeometryColumn(table.table_name);
          
          // Find areas within the parent area
          const query = `
            SELECT 
              child.osm_id,
              child.name,
              child.admin_level,
              child.boundary,
              ST_Area(child.${geomColumn}::geography) / 1000000 as area_sq_km
            FROM ${this.schema}.${table.table_name} child,
                 ${this.schema}.${table.table_name} parent
            WHERE parent.osm_id = $1
              AND child.osm_id != $1
              AND child.admin_level::int > parent.admin_level::int
              AND child.boundary = 'administrative'
              AND child.name IS NOT NULL
              AND ST_Within(ST_Centroid(child.${geomColumn}), parent.${geomColumn})
            ORDER BY child.admin_level::int, child.area_sq_km DESC;
          `;

          const result = await this.pool.query(query, [parentOsmId]);
          
          if (result.rows.length > 0) {
            // Filter to get only the immediate next level
            const minLevel = Math.min(...result.rows.map(r => parseInt(r.admin_level)));
            return result.rows.filter(r => parseInt(r.admin_level) === minLevel);
          }
        } catch (error) {
          // Try next table
        }
      }
    }

    return [];
  }

  /**
   * Find the European Union and get its member country IDs
   * The EU is typically represented as an admin area in OSM
   * @returns {Object} EU information with member country IDs
   */
  async getEUCountries() {
    // Return cached data if available
    if (this.adminAreaCache.euCountries) {
      return this.adminAreaCache.euCountries;
    }

    const osmTables = this.findOSMTables();
    const polygonTables = osmTables.filter(t => 
      t.table_name.includes('polygon') || t.table_name.includes('boundaries')
    );

    if (polygonTables.length === 0) {
      throw new Error('No suitable polygon tables found');
    }

    // First, try to find the EU entity
    for (const table of polygonTables) {
      const columns = this.getTableColumns(table.table_name);
      const hasName = columns.some(c => c.column_name === 'name');
      
      if (hasName) {
        try {
          const geomColumn = this.findGeometryColumn(table.table_name);
          
          // Look for EU entity - it might be named "European Union" or have an EU tag
          const euQuery = `
            SELECT 
              osm_id,
              name,
              admin_level,
              boundary,
              ST_Area(${geomColumn}::geography) / 1000000 as area_sq_km
            FROM ${this.schema}.${table.table_name}
            WHERE (
              name ILIKE '%European Union%' 
              OR name ILIKE '%EU%'
              OR name = 'EU'
            )
            AND boundary = 'administrative'
            LIMIT 1;
          `;

          const euResult = await this.pool.query(euQuery);
          
          if (euResult.rows.length > 0) {
            const eu = euResult.rows[0];
            
            // Now find countries that are within or overlap with the EU
            const memberQuery = `
              SELECT 
                c.osm_id,
                c.name,
                c.admin_level,
                ST_Area(c.${geomColumn}::geography) / 1000000 as area_sq_km
              FROM ${this.schema}.${table.table_name} c,
                   ${this.schema}.${table.table_name} eu
              WHERE eu.osm_id = $1
                AND c.admin_level = '2'
                AND c.boundary = 'administrative'
                AND c.name IS NOT NULL
                AND (
                  ST_Within(ST_Centroid(c.${geomColumn}), eu.${geomColumn})
                  OR ST_Overlaps(c.${geomColumn}, eu.${geomColumn})
                  OR ST_Intersects(c.${geomColumn}, eu.${geomColumn})
                )
              ORDER BY c.name;
            `;

            const memberResult = await this.pool.query(memberQuery, [eu.osm_id]);
            
            const result = {
              eu: eu,
              memberCountries: memberResult.rows,
              memberCountryIds: memberResult.rows.map(c => c.osm_id),
              memberCount: memberResult.rows.length,
            };
            
            this.adminAreaCache.euCountries = result;
            return result;
          }
        } catch (error) {
          console.warn('Error finding EU:', error.message);
        }
      }
    }

    // Fallback: If EU entity not found, use a hardcoded list of EU member countries
    // This is more reliable as the EU boundary might not exist in all OSM databases
    const euMemberNames = [
      'Austria', 'Belgium', 'Bulgaria', 'Croatia', 'Cyprus', 'Czechia', 
      'Denmark', 'Estonia', 'Finland', 'France', 'Germany', 'Greece', 
      'Hungary', 'Ireland', 'Italy', 'Latvia', 'Lithuania', 'Luxembourg',
      'Malta', 'Netherlands', 'Poland', 'Portugal', 'Romania', 'Slovakia',
      'Slovenia', 'Spain', 'Sweden'
    ];
    
    const countries = await this.getCountries();
    const euCountries = countries.filter(c => 
      euMemberNames.some(euName => 
        c.name.includes(euName) || euName.includes(c.name)
      )
    );
    
    const result = {
      eu: {
        osm_id: null,
        name: 'European Union (from member list)',
        admin_level: null,
        note: 'EU boundary not found in database, using member country list',
      },
      memberCountries: euCountries,
      memberCountryIds: euCountries.map(c => c.osm_id),
      memberCount: euCountries.length,
    };
    
    this.adminAreaCache.euCountries = result;
    return result;
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
