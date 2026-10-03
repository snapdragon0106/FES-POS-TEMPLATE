import { createHash, timingSafeEqual } from "crypto";

/**
 * Who may use the register, who is admin, and the class 合言葉 — all read
 * from the server's environment, never from the source code.
 *
 * They used to be constants in shared/posTypes.ts, which the screens
 * imported, so the whole class roster (ID → name) and the admin ID were
 * compiled into the public JavaScript bundle: anyone could read them from
 * /assets/index-*.js without logging in. And since the repository is on
 * GitHub, the roster and the 合言葉 were in the source for anyone to read.
 * Now they exist only in Render's environment variables and in this
 * process's memory; names reach a browser only through authenticated API
 * calls.
 *
 *   POS_MEMBERS      ID → name, either as a plain list
 *                      3501:山田 太郎,3502:佐藤 花子
 *                    (one per line also works; full-width ：、，and digits
 *                    are accepted, since whoever sets this up next year
 *                    types it on a Japanese keyboard) or as a JSON object
 *                      {"3501":"山田 太郎", …}
 *   POS_ADMIN_IDS    comma-separated IDs with admin rights: "3509" or "3509,3512"
 *   POS_ACCESS_CODE  the class 合言葉
 *
 * Missing or malformed values stop the server at boot (assertRosterConfigured),
 * like JWT_SECRET: a deploy that cannot log anyone in should fail on
 * Render — which then keeps the previous version running — rather than
 * go live. The messages are in Japanese and say how to fix the value:
 * they are read in Render's log by whoever set the variable.
 */

type Roster = {
  members: Map<string, string>;
  admins: Set<string>;
  accessCode: string;
};

let cached: Roster | null = null;

const EXAMPLE = "例：3501:山田 太郎,3502:佐藤 花子";

/** Full-width digits (３５０１) → ASCII. */
const asciiDigits = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/** A short, single-line excerpt of a bad entry for the error message. */
const excerpt = (s: string) => (s.length > 24 ? `${s.slice(0, 24)}…` : s).replace(/\s+/g, " ");

/**
 * Reads POS_MEMBERS: a JSON object, or the plain list "番号:名前" separated
 * by commas or new lines. Throws a Japanese message naming the entry to fix.
 */
export function parseMembers(raw: string): Map<string, string> {
  const text = raw.trim().replace(/^\uFEFF/, "");
  const members = new Map<string, string>();
  const add = (rawId: string, rawName: unknown, entry: string) => {
    const id = asciiDigits(String(rawId).trim());
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!/^\d{1,10}$/.test(id) || !name) {
      throw new Error(`POS_MEMBERS の「${excerpt(entry)}」が読めません。番号（数字だけ）と名前を「:」でつないでください（${EXAMPLE}）。`);
    }
    if (name.length > 50) throw new Error(`POS_MEMBERS の番号 ${id} の名前が長すぎます（50文字まで）。`);
    if (members.has(id)) throw new Error(`POS_MEMBERS に番号 ${id} が2回あります。1人1回にしてください。`);
    members.set(id, name);
  };

  if (text.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`POS_MEMBERS の { } の書き方（JSON）が正しくありません。かっこを使わない書き方でも設定できます（${EXAMPLE}）。`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`POS_MEMBERS は「番号:名前」の並びで書いてください（${EXAMPLE}）。`);
    }
    for (const [id, name] of Object.entries(parsed as Record<string, unknown>)) add(id, name, `${id}`);
  } else {
    for (const entry of text.split(/[\r\n,，、;；]+/).map((e) => e.trim()).filter(Boolean)) {
      // "3501:山田 太郎" (also ：, = and ＝), or "3501 山田 太郎" / a tab, as pasted from a spreadsheet.
      const m = entry.match(/^([0-9０-９]+)\s*[:：=＝]\s*(.*)$/) ?? entry.match(/^([0-9０-９]+)[\s\u3000]+(.*)$/);
      if (!m) {
        throw new Error(`POS_MEMBERS の「${excerpt(entry)}」が読めません。番号と名前を「:」でつないで、人と人の間は「,」で区切ってください（${EXAMPLE}）。`);
      }
      add(m[1], m[2], entry);
    }
  }
  if (members.size === 0) throw new Error(`POS_MEMBERS に1人も書かれていません（${EXAMPLE}）。`);
  return members;
}

function load(): Roster {
  if (cached) return cached;

  const rawMembers = process.env.POS_MEMBERS;
  if (!rawMembers || !rawMembers.trim()) {
    throw new Error(`POS_MEMBERS（名簿）が設定されていません。Render の Environment に「番号:名前」の並びで設定してください（${EXAMPLE}）。`);
  }
  const members = parseMembers(rawMembers);

  const admins = new Set(
    asciiDigits(process.env.POS_ADMIN_IDS ?? "")
      .split(/[,，、\s\u3000]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
  if (admins.size === 0) {
    throw new Error("POS_ADMIN_IDS（管理者の番号）が設定されていません。管理者の番号を設定してください（例：3501。2人なら 3501,3502）。");
  }
  for (const id of Array.from(admins)) {
    if (!members.has(id)) throw new Error(`POS_ADMIN_IDS の ${id} が POS_MEMBERS（名簿）にありません。名簿にある番号を設定してください。`);
  }

  const accessCode = (process.env.POS_ACCESS_CODE ?? "").trim();
  if (!accessCode) throw new Error("POS_ACCESS_CODE（合言葉）が設定されていません。");

  cached = { members, admins, accessCode };
  return cached;
}

/** Throws with a readable message if the roster env vars are missing or malformed. */
export function assertRosterConfigured(): void {
  load();
}

export function isMember(id: string): boolean {
  return load().members.has(id);
}

export function memberName(id: string): string {
  return load().members.get(id) ?? "";
}

export function isAdmin(id: string): boolean {
  return load().admins.has(id);
}

/** The whole roster, for logged-in screens (history, PIN management). */
export function listMembers(): { id: string; name: string }[] {
  return Array.from(load().members.entries())
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

/**
 * Compares digests, not the strings: timingSafeEqual needs equal lengths,
 * and bailing out early on a length mismatch made a wrong-length guess a
 * little faster than a right-length one — a (tiny) hint at the 合言葉's
 * length. Hashing first makes every guess cost the same.
 */
export function accessCodeMatches(input: string): boolean {
  const digest = (s: string) => createHash("sha256").update(`fespos-code:${s}`).digest();
  return timingSafeEqual(digest(input), digest(load().accessCode));
}

/**
 * A short fingerprint of the current 合言葉, stored in the gate cookie. If
 * the 合言葉 is changed on Render, every existing gate cookie stops
 * matching and everyone has to enter the new one.
 */
export function accessCodeFingerprint(): string {
  return createHash("sha256").update(`fespos-gate:${load().accessCode}`).digest("hex").slice(0, 16);
}

/** Tests only: forget the parsed env so a test can change it. */
export function __resetRosterCache(): void {
  cached = null;
}
