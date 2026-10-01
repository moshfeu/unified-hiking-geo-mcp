# unified-hiking-geo-mcp

One MCP server that unifies two upstream stdio servers behind 7 purpose-built tools:

- `@skills-il/israel-hiking-mcp` — Israel-specific POI/trail data (Hebrew-aware, rich descriptions)
- `mcp-geo` — general-purpose Overpass/Nominatim/OSRM geospatial tools

## Tools and routing

| Tool | Backing MCP(s) |
|---|---|
| `search_place` | israel-hiking first, falls back to mcp-geo geocode if empty |
| `find_near_by_type` | mcp-geo (`overpass_query`) only — the gap the original israel-hiking search couldn't fill |
| `get_poi_details` | israel-hiking only |
| `find_official_trail` | israel-hiking only |
| `plan_hiking_route` | israel-hiking (`plan_route`) first, falls back to mcp-geo (`route`/OSRM) on failure |
| `geocode_address` | mcp-geo (`geocode`) only |
| `convert_coordinates` | israel-hiking only |

`unified-server.js` is a stdio MCP server implementing this. `bridge.js` wraps it with `mcp-proxy` to expose it over Streamable HTTP (same pattern as the two earlier bridges), since Claude mobile/web can't spawn stdio processes directly.

Connector URL once deployed: `https://<hostname>/mcp`
