import { afterEach, describe, expect, it } from "vitest";
import { __resetRosterCache, assertRosterConfigured, isAdmin, listMembers, parseMembers } from "./roster";

const asObject = (m: Map<string, string>) => Object.fromEntries(m);

describe("POS_MEMBERS (名簿) formats", () => {
  it("reads the plain list: 番号:名前 separated by commas, names keep their spaces", () => {
    expect(asObject(parseMembers("3501:山田 太郎,3502:佐藤 花子"))).toEqual({ "3501": "山田 太郎", "3502": "佐藤 花子" });
  });

  it("accepts what a Japanese keyboard types: full-width digits, ：、，and spaces around", () => {
    expect(asObject(parseMembers(" ３５０１：山田 太郎、 3502 : 佐藤 花子，3503=鈴木 一郎 "))).toEqual({
      "3501": "山田 太郎",
      "3502": "佐藤 花子",
      "3503": "鈴木 一郎",
    });
  });

  it("accepts one per line, and tab or space separated rows pasted from a spreadsheet", () => {
    expect(asObject(parseMembers("3501\t山田 太郎\r\n3502 佐藤 花子\n\n3503　鈴木 一郎\n"))).toEqual({
      "3501": "山田 太郎",
      "3502": "佐藤 花子",
      "3503": "鈴木 一郎",
    });
  });

  it("still reads the JSON object used so far", () => {
    expect(asObject(parseMembers('{"3501":"山田 太郎","3502":"佐藤 花子"}'))).toEqual({ "3501": "山田 太郎", "3502": "佐藤 花子" });
  });

  it("says in Japanese which entry is wrong", () => {
    expect(() => parseMembers("3501:山田 太郎,佐藤 花子")).toThrow(/「佐藤 花子」が読めません/);
    expect(() => parseMembers("3501:")).toThrow(/が読めません/);
    expect(() => parseMembers("3501:山田,3501:佐藤")).toThrow(/番号 3501 が2回あります/);
    expect(() => parseMembers('{"3501":"山田"')).toThrow(/JSON/);
    expect(() => parseMembers(" , ")).toThrow(/1人も書かれていません/);
  });
});

describe("roster env at boot", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    __resetRosterCache();
  });

  it("works with the plain list and full-width admin numbers", () => {
    process.env.POS_MEMBERS = "3501:山田 太郎,3502:佐藤 花子";
    process.env.POS_ADMIN_IDS = "３５０２";
    process.env.POS_ACCESS_CODE = "あいことば";
    __resetRosterCache();
    expect(() => assertRosterConfigured()).not.toThrow();
    expect(isAdmin("3502")).toBe(true);
    expect(listMembers().map((m) => m.id)).toEqual(["3501", "3502"]);
  });

  it("refuses an admin number that isn't on the roster, and a missing 合言葉, with a message to act on", () => {
    process.env.POS_MEMBERS = "3501:山田 太郎";
    process.env.POS_ADMIN_IDS = "3509";
    process.env.POS_ACCESS_CODE = "x";
    __resetRosterCache();
    expect(() => assertRosterConfigured()).toThrow(/POS_ADMIN_IDS の 3509 が POS_MEMBERS（名簿）にありません/);
    process.env.POS_ADMIN_IDS = "3501";
    process.env.POS_ACCESS_CODE = "   ";
    __resetRosterCache();
    expect(() => assertRosterConfigured()).toThrow(/POS_ACCESS_CODE（合言葉）が設定されていません/);
  });
});
