export function allowedCorsOrigin(pattern: string, origin: string): boolean {
  return new RegExp(`^(?:${pattern})$`).test(origin);
}
