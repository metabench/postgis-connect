# postgis-connect

Node.js adapter to connect to a PostGIS OSM database, providing a unified access pattern to various database setups with support for hierarchical admin area facades.

## Features

- **Comprehensive Schema Analysis**: Automatically discovers and analyzes database structure with detailed mapping
- **Database Introspection**: Discovers tables, views, columns, indexes, and constraints
- **OSM-Aware**: Recognizes common osm2pgsql table patterns and structures
- **Schema Mapping**: Analyzes how the database maps to OSM expectations
- **Country Data**: Retrieve country boundaries with PostGIS-calculated areas
- **Hierarchical Admin Areas**: Get admin areas at any level, organized hierarchically within countries
- **Three-Level Hierarchy Facade**: Query countries with nested sub-levels in a single call
- **EU Countries Facade**: Find European Union and retrieve member country IDs
- **Facade Pattern Support**: Foundation for implementing various access facades for different admin levels
- **Flexible**: Adapts to different osm2pgsql configurations and table naming conventions
- **Metadata Caching**: Introspects database once and caches metadata for efficient access
- **Config File Support**: Load configuration from JSON file

## Installation

```bash
npm install
```

## Configuration

Create a `config/config.json` file based on `config/config.example.json`:

```bash
cp config/config.example.json config/config.json
```

Edit `config/config.json` with your database credentials:

```json
{
  "host": "localhost",
  "port": 5432,
  "database": "osm",
  "user": "postgres",
  "password": "your_password",
  "schema": "public"
}
```

Alternatively, you can still use environment variables with a `.env` file or pass configuration directly to the constructor.

## Usage

### Basic Usage

```javascript
const PostGISAdapter = require('postgis-connect');

// Automatically loads from config/config.json
const adapter = new PostGISAdapter();

// Or specify a custom config file path
const adapter = new PostGISAdapter(null, './custom/path/config.json');

// Or pass configuration directly
const adapter = new PostGISAdapter({
  host: 'localhost',
  port: 5432,
  database: 'osm',
  user: 'postgres',
  password: 'password',
  schema: 'public'
});

// Connect and introspect database
await adapter.connect();

// Get all tables
const tables = adapter.getTables();

// Get OSM-specific tables
const osmTables = adapter.findOSMTables();

// Get countries with calculated areas
const countries = await adapter.getCountries();

// Close connection
await adapter.close();
```

### Database Introspection

The adapter automatically introspects the database to discover:

1. **Tables**: All tables in the schema with size information
2. **Views**: All views in the schema with their definitions
3. **Columns**: All columns in tables and views with data types
4. **Indexes**: All indexes for optimization analysis
5. **Constraints**: Primary keys, foreign keys, and other constraints

```javascript
// Get all discovered tables
const tables = adapter.getTables();

// Get all discovered views
const views = adapter.getViews();

// Get columns for a specific table
const columns = adapter.getTableColumns('planet_osm_polygon');

// Get full metadata for a table
const metadata = adapter.getTableMetadata('planet_osm_polygon');
```

### Comprehensive Schema Analysis

The adapter performs comprehensive analysis of the database schema:

```javascript
// Get detailed schema analysis
const analysis = adapter.getSchemaAnalysis();

// Analysis includes:
// - OSM table mapping (point, line, polygon, boundaries)
// - Geometry column information
// - Admin level distribution
// - Available admin levels in the database
// - Recommended tables for common operations
```

The schema analysis helps the adapter:
- Map database structure to OSM expectations
- Identify the best tables for specific queries
- Understand admin level availability
- Provide detailed structural information for facades

### Working with OSM Data

The adapter recognizes common osm2pgsql patterns:

```javascript
// Find all OSM-related tables
const osmTables = adapter.findOSMTables();
// Returns tables matching patterns like:
// - planet_osm_point
// - planet_osm_line
// - planet_osm_polygon
// - planet_osm_roads
```

### Getting Country Data

Retrieve country boundaries with PostGIS-calculated areas:

```javascript
const countries = await adapter.getCountries();
// Returns array of countries with:
// - osm_id: OSM identifier
// - name: Country name
// - admin_level: OSM admin level (2 for countries)
// - boundary: Boundary type
// - area_sq_km: Area in square kilometers
// - area_sq_meters: Area in square meters
```

### Hierarchical Admin Areas (Facade Pattern)

The adapter provides methods to work with hierarchical administrative boundaries:

#### Get Admin Areas by Level

```javascript
// Get all admin level 4 areas (typically states/provinces)
const states = await adapter.getAdminAreasByLevel('4');

// Get all admin level 6 areas (typically counties/districts)
const counties = await adapter.getAdminAreasByLevel('6');
```

OSM Admin Levels:
- Level 2: Countries
- Level 3: Regions (not always used)
- Level 4: States/Provinces
- Level 5: Sometimes used for regions
- Level 6: Counties/Districts
- Level 7: Municipalities
- Level 8: Cities/Towns

#### Get Admin Areas within a Country

```javascript
// Get states/provinces within the United States
const usStates = await adapter.getAdminAreasInCountry('United States', '4');

// Get counties within Germany
const germanCounties = await adapter.getAdminAreasInCountry('Germany', '6');
```

#### Get Next Admin Level Down

Automatically finds the next available admin level within a country:

```javascript
const nextLevel = await adapter.getNextAdminLevelInCountry('Canada');
// Returns:
// {
//   adminLevel: '4',  // The level found
//   areas: [...]      // Array of admin areas at that level
// }
```

#### Get Hierarchical Structure

Get countries with their sub-areas organized hierarchically:

```javascript
const hierarchical = await adapter.getHierarchicalAdminAreas('4');
// Returns countries with nested sub-areas:
// [
//   {
//     name: 'United States',
//     area_sq_km: 9833517,
//     admin_level: '2',
//     subAreas: [
//       { name: 'California', area_sq_km: 423970, ... },
//       { name: 'Texas', area_sq_km: 695662, ... },
//       ...
//     ],
//     subAreaCount: 50
//   },
//   ...
// ]
```

### Three-Level Hierarchy Facade

Get countries with two nested levels of sub-divisions in a single query:

```javascript
// Get top 5 countries with their hierarchical sub-divisions
const threeLevels = await adapter.getThreeLevelHierarchy(5);
// Returns:
// [
//   {
//     country: { name: 'United States', osm_id: 123, ... },
//     level1AdminLevel: '4',  // States
//     level1Areas: [
//       {
//         name: 'California',
//         osm_id: 456,
//         subAreas: [
//           { name: 'Los Angeles County', ... },
//           { name: 'San Francisco County', ... },
//           ...
//         ],
//         subAreaCount: 58
//       },
//       ...
//     ],
//     level1Count: 50
//   },
//   ...
// ]
```

This facade is useful for:
- Building navigation hierarchies
- Creating drill-down interfaces
- Understanding administrative structure at multiple levels

### European Union Countries Facade

Find the EU and get its member country IDs:

```javascript
const euData = await adapter.getEUCountries();
// Returns:
// {
//   eu: {
//     osm_id: 123456,
//     name: 'European Union',
//     admin_level: '2',
//     area_sq_km: 4233255
//   },
//   memberCountries: [
//     { osm_id: 1, name: 'Austria', ... },
//     { osm_id: 2, name: 'Belgium', ... },
//     ...
//   ],
//   memberCountryIds: [1, 2, 3, ...],
//   memberCount: 27
// }
```

This facade:
- Finds the EU entity in the database (admin area)
- Uses spatial queries to find countries within EU boundaries
- Falls back to a known member list if EU boundary not in database
- Returns member country OSM IDs for further queries

### Raw Queries

Execute custom SQL queries:

```javascript
const result = await adapter.query(
  'SELECT name, ST_Area(way::geography) as area FROM planet_osm_polygon WHERE admin_level = $1',
  ['2']
);
```

## Testing

Run the test/example script:

```bash
npm test
```

This will:
1. Connect to the database
2. Display discovered tables and views
3. Show comprehensive schema analysis
4. Show OSM-specific tables and their columns
5. Display available admin levels
6. List countries with calculated areas
7. Demonstrate hierarchical admin area queries
8. Show three-level hierarchy facade
9. Display EU countries and member IDs

## How it Works

### Database Introspection

On connection, the adapter runs several queries to understand the database structure:

1. Queries `information_schema.tables` to find all tables and their sizes
2. Queries `information_schema.views` to discover views
3. Queries `information_schema.columns` to get column information
4. Queries `pg_class` and `pg_index` to discover indexes
5. Queries `information_schema.table_constraints` for constraints

### Comprehensive Schema Analysis

After introspection, the adapter performs comprehensive analysis:

1. **OSM Table Mapping**: Categorizes tables by type (point, line, polygon, boundaries)
2. **Geometry Column Analysis**: Identifies all geometry/geography columns
3. **Admin Level Distribution**: Discovers which admin levels exist and their counts
4. **Recommendations**: Suggests best tables for common operations

This analysis:
- Maps the database structure to OSM expectations
- Ensures queries use the correct tables and columns
- Identifies optimal access patterns
- Provides detailed structural information for building facades

This metadata is cached and used to:
- Adapt to different osm2pgsql configurations
- Find the correct geometry column names (way, geom, etc.)
- Identify OSM-specific tables
- Ensure correct table and column access

### Country Detection

The `getCountries()` method:

1. Identifies potential tables containing country boundaries (polygon tables)
2. Checks for necessary columns (name, admin_level, boundary, geometry)
3. Queries for features with `admin_level = '2'` and `boundary = 'administrative'`
4. Calculates areas using PostGIS `ST_Area()` function
5. Returns results sorted by area (largest first)

### OSM2PGSQL Compatibility

The adapter works with various osm2pgsql configurations by:

- Detecting table naming patterns (planet_osm_*, osm_*, etc.)
- Identifying geometry column names dynamically (way, geom, etc.)
- Supporting different data types (geometry, geography)
- Adapting queries based on discovered schema

## License

MIT
