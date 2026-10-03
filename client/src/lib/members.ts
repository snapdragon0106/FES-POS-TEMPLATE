import { useCallback, useMemo } from "react";
import { trpc } from "@/lib/trpc";

/**
 * The class roster, fetched from the server after login (member.list).
 * It used to be a constant compiled into the app, which put every name in
 * the public JavaScript bundle for anyone to read.
 */
export function useMembers() {
  const query = trpc.member.list.useQuery(undefined, { staleTime: 10 * 60_000, retry: 1 });
  const members = query.data ?? [];
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);
  const nameOf = useCallback((id: string | number | null | undefined) => (id == null ? "" : byId.get(String(id)) ?? ""), [byId]);
  return { members, nameOf };
}
