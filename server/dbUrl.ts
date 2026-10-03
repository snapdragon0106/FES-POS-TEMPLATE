/**
 * Tidies DATABASE_URL as pasted by whoever set the service up, so a value
 * copied from TiDB Cloud's "Connect" dialog works whichever snippet they
 * took. The people setting this up next year aren't expected to know what
 * a connection string looks like:
 *
 * - the whole line was pasted: `DATABASE_URL='mysql://…'` → the URL alone
 * - surrounding quotes or spaces → removed
 * - a TiDB Cloud host without TLS settings → TLS on. TiDB Cloud refuses
 *   unencrypted connections, and mysql2 only turns TLS on for an `ssl`
 *   parameter; other snippets say `sslaccept=strict` (Prisma) or
 *   `ssl-mode=VERIFY_IDENTITY`, which mysql2 ignores — it then connected
 *   in the clear and was turned away.
 *
 * An `ssl` parameter that is already there is left exactly as it is.
 */
export function normalizeDatabaseUrl(raw: string): string {
  let url = raw.trim().replace(/^DATABASE_URL\s*=\s*/i, "").trim();
  if ((url.startsWith("'") && url.endsWith("'")) || (url.startsWith('"') && url.endsWith('"'))) {
    url = url.slice(1, -1).trim();
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url; // let the driver report it
  }
  if (!/\.tidbcloud\.com$/i.test(parsed.hostname)) return url;
  if (parsed.searchParams.has("ssl")) return url;
  for (const key of ["sslaccept", "ssl-mode", "sslmode", "ssl_mode"]) parsed.searchParams.delete(key);
  parsed.searchParams.set("ssl", JSON.stringify({ minVersion: "TLSv1.2", rejectUnauthorized: true }));
  return parsed.toString();
}
