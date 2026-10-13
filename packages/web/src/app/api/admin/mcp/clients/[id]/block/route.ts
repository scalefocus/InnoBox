// POST /api/admin/mcp/clients/:id/block (INNOBOX_SPEC.md §25.10): blocks one AI agent client — it
// can no longer obtain a grant, exchange a code, refresh or call /mcp. Its grants stay, so
// unblocking restores them. Platform admin only; audited `mcp.client_blocked`.
import { blockRoute } from "../block-route";

export const dynamic = "force-dynamic";

export const POST = blockRoute(true);
