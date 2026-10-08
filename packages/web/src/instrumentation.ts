// Next.js instrumentation hook — register() runs once when the server starts (in the standalone
// production server too; never during `next build`). INNOBOX_SPEC.md §2.3: a production build
// that finds INNOBOX_DEV_AUTH set refuses to start. Only the Node.js runtime can exit the
// process; the edge runtime (middleware) has no process.exit and needs no second check.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { devAuthStartupViolation } = await import("./lib/dev-auth-guard");
  const fatal = devAuthStartupViolation({
    NODE_ENV: process.env.NODE_ENV,
    INNOBOX_DEV_AUTH: process.env.INNOBOX_DEV_AUTH,
  });
  if (fatal) {
    console.error(fatal);
    process.exit(1);
  }
}
