export function organizationMembershipHttpStatus(
  sqlState: string | null,
): 400 | 403 | 404 | 409 | null {
  if (sqlState === "22023" || sqlState === "23514") return 400;
  if (sqlState === "42501") return 403;
  if (sqlState === "P0002") return 404;
  if (sqlState === "23505" || sqlState === "40001" || sqlState === "55000" || sqlState === "55P03")
    return 409;
  return null;
}
