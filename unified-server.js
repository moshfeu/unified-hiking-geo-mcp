import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';

const MAP_RESOURCE_URI = 'ui://israel-hiking/map.html';
const MAP_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>html,body{margin:0;padding:0;height:100%;}iframe{width:100%;height:100%;border:0;}</style>
</head>
<body>
<iframe src="https://israelhiking.osm.org.il/" allow="geolocation"></iframe>
</body>
</html>`;

function textOf(result) {
  try {
    return (result?.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
  } catch {
    return '';
  }
}

function looksEmpty(text) {
  if (!text) return true;
  const t = text.trim();
  if (t.length === 0) return true;
  return /no results|not found|0 results|no matching/i.test(t);
}

async function main() {
  const server = new McpServer({ name: 'unified-hiking-geo', version: '1.0.0' });

  // --- MCP Apps feasibility test: an embedded webview, no upstream needed ---
  registerAppResource(
    server,
    'Israel Hiking Map',
    MAP_RESOURCE_URI,
    { description: 'Embedded Israel Hiking Map webview' },
    async () => ({
      contents: [
        {
          uri: MAP_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: MAP_HTML,
          _meta: {
            ui: {
              frameDomains: ['israelhiking.osm.org.il'],
            },
          },
        },
      ],
    })
  );

  registerAppTool(
    server,
    'show_israel_hiking_map',
    {
      title: 'Show Israel Hiking Map',
      description: 'Displays an embedded, interactive webview of the Israel Hiking Map (israelhiking.osm.org.il). Feasibility test for MCP Apps UI rendering.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: MAP_RESOURCE_URI } },
    },
    async () => ({
      content: [{ type: 'text', text: 'Showing the Israel Hiking Map.' }],
    })
  );
  // IMPORTANT: do NOT await these child connections before server.connect()
  // below. mcp-proxy (which wraps this process) has its own ~60s timeout
  // waiting for OUR initialize response. Cold npx/uvx startup for the two
  // children can exceed that on a fresh container, which would kill the
  // handshake before any tool is ever called. Instead, kick both off in the
  // background here and let each tool handler await its own client lazily,
  // on first real use.

  // --- upstream #1: Israel Hiking Map (Hebrew-aware POI/trail data) ---
  const ihClientPromise = (async () => {
    const c = new Client({ name: 'unified-hiking-geo', version: '1.0.0' });
    await c.connect(
      new StdioClientTransport({ command: 'node', args: ['node_modules/.bin/israel-hiking-mcp'] })
    );
    console.error('[unified-hiking-geo] israel-hiking child ready');
    return c;
  })();
  ihClientPromise.catch((err) => console.error('[unified-hiking-geo] israel-hiking child failed', err));

  // --- upstream #2: mcp-geo (Overpass / Nominatim / OSRM, general purpose) ---
  const geoClientPromise = (async () => {
    const c = new Client({ name: 'unified-hiking-geo', version: '1.0.0' });
    await c.connect(
      new StdioClientTransport({ command: 'uvx', args: ['--with', 'mcp<2', 'mcp-geo'] })
    );
    console.error('[unified-hiking-geo] mcp-geo child ready');
    return c;
  })();
  geoClientPromise.catch((err) => console.error('[unified-hiking-geo] mcp-geo child failed', err));

  // 1. search_place — israel-hiking first, mcp-geo geocode fallback
  server.tool(
    'search_place',
    "Free-text search for a place or POI name (e.g. Hebrew names like 'מפלון'). Tries Israel Hiking Map first (best for Israeli/Hebrew place names with rich descriptions), and falls back to general OSM/Nominatim geocoding if nothing relevant is found. Use this when you have a NAME, not a feature type.",
    {
      query: z.string().describe('Search text, e.g. a place or POI name'),
      language: z.string().optional().describe("Language code for israel-hiking search, e.g. 'he' or 'en'. Defaults to 'he'."),
    },
    async ({ query, language }) => {
      const ihClient = await ihClientPromise;
      const ihResult = await ihClient.callTool({ name: 'search_pois', arguments: { query, language: language ?? 'he' } });
      const ihText = textOf(ihResult);
      if (!looksEmpty(ihText)) {
        return { content: [{ type: 'text', text: `[source: israel-hiking]\n${ihText}` }] };
      }
      const geoClient = await geoClientPromise;
      const geoResult = await geoClient.callTool({ name: 'geocode', arguments: { query } });
      return { content: [{ type: 'text', text: `[source: mcp-geo geocode fallback]\n${textOf(geoResult)}` }] };
    }
  );

  // 2. find_near_by_type — mcp-geo Overpass only (the actual gap we identified)
  server.tool(
    'find_near_by_type',
    "Find OSM features of a given tag (e.g. tag_key='waterway', tag_value='waterfall'; or tag_key='natural', tag_value='spring') within a radius in meters of a lat/lon point, via Overpass. Queries node+way+relation together, so linear features like streams (usually mapped as ways) are found too, not just point features. Use this for 'find all X near Y' queries where X is a FEATURE TYPE, not a specific name — this is the one true gap neither upstream server covers alone.",
    {
      tag_key: z.string().describe("OSM tag key, e.g. 'waterway', 'natural', 'amenity'"),
      tag_value: z.string().describe("OSM tag value, e.g. 'waterfall', 'spring', 'drinking_water', 'stream'"),
      lat: z.number(),
      lon: z.number(),
      radius_m: z.number().default(1000).describe('Search radius in meters'),
    },
    async ({ tag_key, tag_value, lat, lon, radius_m }) => {
      const geoClient = await geoClientPromise;
      // nwr = node+way+relation in one go; "out center" gives a usable lat/lon
      // for way/relation results too (streams, water bodies, etc. are usually
      // mapped as ways, not nodes — querying node-only silently misses them).
      const q = `[out:json];nwr["${tag_key}"="${tag_value}"](around:${radius_m},${lat},${lon});out center;`;
      const result = await geoClient.callTool({ name: 'overpass_query', arguments: { ql_string: q } });
      return { content: [{ type: 'text', text: `[source: mcp-geo overpass]\n${textOf(result)}` }] };
    }
  );

  // 3. get_poi_details — israel-hiking only (rich descriptions/images)
  server.tool(
    'get_poi_details',
    'Get full details (description, image, category) for a specific POI by id/source, as known to Israel Hiking Map. Use the id/source returned by search_place or find_near_by_type.',
    {
      id: z.string(),
      source: z.string().describe("e.g. 'OSM'"),
    },
    async ({ id, source }) => {
      const ihClient = await ihClientPromise;
      const result = await ihClient.callTool({ name: 'get_poi_details', arguments: { id, source } });
      return { content: [{ type: 'text', text: textOf(result) }] };
    }
  );

  // 4. find_official_trail — israel-hiking only
  server.tool(
    'find_official_trail',
    'Search for documented/official hiking or biking trails in Israel (Israel Hiking Map). Use for named trail relations, not arbitrary paths.',
    { query: z.string() },
    async ({ query }) => {
      const ihClient = await ihClientPromise;
      const result = await ihClient.callTool({ name: 'find_trails', arguments: { query } });
      return { content: [{ type: 'text', text: textOf(result) }] };
    }
  );

  // 5. plan_hiking_route — israel-hiking first, mcp-geo/OSRM fallback
  server.tool(
    'plan_hiking_route',
    "Plan a walking/hiking route between two points. Uses Israel Hiking Map's routing by default (tuned for Israeli trails/terrain, gives elevation profile); falls back to OSRM (mcp-geo) if that fails or the points are outside Israel.",
    {
      from_lat: z.number(),
      from_lng: z.number(),
      to_lat: z.number(),
      to_lng: z.number(),
      route_type: z.string().default('Hike'),
    },
    async (args) => {
      const ihClient = await ihClientPromise;
      try {
        const result = await ihClient.callTool({ name: 'plan_route', arguments: args });
        return { content: [{ type: 'text', text: `[source: israel-hiking]\n${textOf(result)}` }] };
      } catch (err) {
        const geoClient = await geoClientPromise;
        const result = await geoClient.callTool({
          name: 'route',
          arguments: {
            coordinates: [
              [args.from_lng, args.from_lat],
              [args.to_lng, args.to_lat],
            ],
            profile: 'foot',
          },
        });
        return { content: [{ type: 'text', text: `[source: mcp-geo OSRM fallback, israel-hiking failed: ${err?.message ?? err}]\n${textOf(result)}` }] };
      }
    }
  );

  // 6. geocode_address — mcp-geo only
  server.tool(
    'geocode_address',
    'Convert a street address (not a place name or POI) to coordinates, via Nominatim. For place/POI names, use search_place instead.',
    { query: z.string() },
    async ({ query }) => {
      const geoClient = await geoClientPromise;
      const result = await geoClient.callTool({ name: 'geocode', arguments: { query } });
      return { content: [{ type: 'text', text: textOf(result) }] };
    }
  );

  // 7. convert_coordinates — israel-hiking only
  server.tool(
    'convert_coordinates',
    'Convert coordinates between Israel Transverse Mercator (ITM) and WGS84.',
    {
      lat: z.number().optional(),
      lon: z.number().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      direction: z.string().describe("'itm_to_wgs84' or 'wgs84_to_itm'"),
    },
    async (args) => {
      const ihClient = await ihClientPromise;
      const result = await ihClient.callTool({ name: 'convert_coordinates', arguments: args });
      return { content: [{ type: 'text', text: textOf(result) }] };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[unified-hiking-geo] ready (stdio), children connecting in background');
}

main().catch((err) => {
  console.error('fatal', err);
  process.exit(1);
});
