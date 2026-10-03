import { describe, expect, it } from "vitest";
import { normalizeDatabaseUrl } from "./dbUrl";

const HOST = "gateway01.ap-northeast-1.prod.aws.tidbcloud.com";
const sslOf = (url: string) => JSON.parse(new URL(url).searchParams.get("ssl") ?? "null");

describe("DATABASE_URL as pasted from TiDB Cloud", () => {
  it("turns TLS on for a TiDB Cloud host given without TLS settings", () => {
    const url = normalizeDatabaseUrl(`mysql://abc.root:pw123@${HOST}:4000/fespos`);
    expect(sslOf(url)).toEqual({ minVersion: "TLSv1.2", rejectUnauthorized: true });
    expect(new URL(url).pathname).toBe("/fespos");
    expect(new URL(url).username).toBe("abc.root");
  });

  it("replaces settings mysql2 ignores (Prisma's sslaccept, ssl-mode) with real TLS", () => {
    for (const q of ["sslaccept=strict", "ssl-mode=VERIFY_IDENTITY", "sslmode=require"]) {
      const url = normalizeDatabaseUrl(`mysql://abc.root:pw@${HOST}:4000/test?${q}`);
      const params = new URL(url).searchParams;
      expect(sslOf(url)).toEqual({ minVersion: "TLSv1.2", rejectUnauthorized: true });
      expect([...params.keys()]).toEqual(["ssl"]);
    }
  });

  it("leaves an ssl parameter that is already there as it is", () => {
    const given = `mysql://abc.root:pw@${HOST}:4000/test?ssl={"rejectUnauthorized":true}`;
    expect(normalizeDatabaseUrl(given)).toBe(given);
  });

  it("accepts the whole line pasted, with quotes and spaces", () => {
    const url = normalizeDatabaseUrl(`  DATABASE_URL='mysql://abc.root:pw@${HOST}:4000/fespos'  `);
    expect(url.startsWith(`mysql://abc.root:pw@${HOST}:4000/fespos?ssl=`)).toBe(true);
    expect(normalizeDatabaseUrl(`"mysql://u:p@${HOST}:4000/x"`).startsWith("mysql://u:p@")).toBe(true);
  });

  it("doesn't touch other hosts (a local database)", () => {
    expect(normalizeDatabaseUrl("mysql://root@127.0.0.1:4000/fespos")).toBe("mysql://root@127.0.0.1:4000/fespos");
  });
});
