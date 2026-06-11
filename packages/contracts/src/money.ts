const USD_CENT_EPSILON = 1e-9;

export function isCentPrecisionUsdAmount(amount: number): boolean {
  if (!Number.isFinite(amount)) {
    return false;
  }

  const cents = Math.round(amount * 100);
  return Math.abs(amount - cents / 100) < USD_CENT_EPSILON;
}
