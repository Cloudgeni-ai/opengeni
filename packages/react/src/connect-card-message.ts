/**
 * A failure a connect card explains in its own words. Cards show its message;
 * any other failure (an API response, a network error, a library error) gets
 * the card's plain fallback line, so server or transport text never reaches
 * the person.
 */
export class ConnectCardMessage extends Error {
  override name = "ConnectCardMessage";
}
