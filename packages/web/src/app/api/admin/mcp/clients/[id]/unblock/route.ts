// POST /api/admin/mcp/clients/:id/unblock (INNOBOX_SPEC.md §25.10): lifts a block — the client's
// grants, which were kept, work again. Platform admin only; audited `mcp.client_unblocked`.
import { blockRoute } from "../block-route";

export const dynamic = "force-dynamic";

export const POST = blockRoute(false);
