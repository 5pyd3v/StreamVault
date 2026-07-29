import type { ReactNode } from "react";
import { Navigate } from "react-router";
import type { AuthUser } from "../../lib/api";

/**
 * Route guard for the admin-only subtree (`/admin`, `/admin/dashboard`,
 * `/admin/encoding`, `/admin/storage`).
 *
 * This is the real client-side security boundary — hiding nav links is only
 * cosmetic. The authoritative check still lives on the server (`protect` +
 * `requireAdmin` middleware); this guard just keeps the UI honest.
 */
export default function RequireAdmin({
  user,
  children,
}: {
  user: AuthUser | null;
  children: ReactNode;
}) {
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== "admin") return <Navigate to="/library" replace />;
  return <>{children}</>;
}
