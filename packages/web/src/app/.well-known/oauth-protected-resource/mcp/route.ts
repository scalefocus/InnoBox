// GET /.well-known/oauth-protected-resource/mcp (INNOBOX_SPEC.md §25.2): the same RFC 9728 document
// at the path-suffixed location (RFC 9728 §3.1) MCP clients try for the `/mcp` resource.
import { GET as getMetadata } from "../route";

export const dynamic = "force-dynamic";

export const GET = getMetadata;
