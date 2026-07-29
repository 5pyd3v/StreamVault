import { Navigate, Outlet } from "react-router";
import type { AuthUser } from "../../lib/api";

/**
 * Auth gate for routes that render *outside* `AppShell`.
 *
 * The cinematic players (`/watch/:videoId`, `/watch/live/:slug`) are
 * `position: fixed` full-screen surfaces. `AppShell` wraps its `<Outlet/>` in a
 * `motion.div` that animates `y`, and a transformed ancestor becomes the
 * containing block for fixed descendants — which would offset the player while
 * the page transition runs. Rendering them as a sibling of the shell keeps the
 * viewport as the containing block, and this guard preserves the same
 * "session required" behaviour the shell provides.
 */
export default function RequireAuth({ user }: { user: AuthUser | null }) {
  if (!user) return <Navigate to="/login" replace />;
  return <Outlet />;
}
