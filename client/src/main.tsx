import { trpc } from "@/lib/trpc";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient();

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;

  const posErrorCode = (error.data as { code?: string } | undefined)?.code;
  // Neither a session nor the 合言葉 cookie: the server hides the whole
  // API (a plain 404, not a tRPC error — so no data). Same way out.
  const hidden = !error.data && (error.meta?.response as Response | undefined)?.status === 404;
  if (posErrorCode === "UNAUTHORIZED" || hidden) {
    // The session ended (expired, logged out elsewhere, PIN reset). The
    // server's login page takes over — a navigation, not a reload, so the
    // decision is the server's (server/gate.ts).
    window.location.replace("/");
  }
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Mutation Error]", error);
  }
});

// This app no longer runs inside a cross-site iframe (it used to, under
// Manus's preview), so the POS session token now lives only in the
// httpOnly "pos_session" cookie sent automatically via credentials:
// "include" below. It is never read into JS or copied to localStorage —
// a leftover copy from before this change would have made the cookie's
// httpOnly protection pointless against XSS. Clear that stale copy once
// on load for anyone who was already logged in.
if (typeof window !== "undefined") {
  window.localStorage.removeItem("pos_token");
  // Likewise the old client-side 合言葉 flag and "logged in" marker: the
  // server decides both from its cookies now.
  window.localStorage.removeItem("pos_access_verified");
  window.localStorage.removeItem("pos_operator");
}

/**
 * Every request gets a deadline. Without one, a request to a server or
 * database that has stopped answering (rather than refusing) never
 * settles: the checkout button sits on 処理中... forever and the cashier
 * cannot tell whether to wait, retry or switch to paper. After this long
 * the request fails with a normal connection error, which the UI turns into
 * a clear instruction. Retrying a checkout after a timeout is safe — the
 * server de-duplicates it by clientRequestId.
 */
const REQUEST_TIMEOUT_MS = 15_000;

function withDeadline(init: RequestInit | undefined): RequestInit {
  const controller = new AbortController();
  const upstream = init?.signal;
  if (upstream) {
    // Keep honouring tRPC/React Query's own cancellation.
    if (upstream.aborted) controller.abort(upstream.reason);
    else upstream.addEventListener("abort", () => controller.abort(upstream.reason), { once: true });
  }
  // Left running after the response on purpose: it also bounds reading the
  // body, and aborting an already-finished request is a no-op.
  setTimeout(
    () => controller.abort(new DOMException("request timed out", "TimeoutError")),
    REQUEST_TIMEOUT_MS
  );
  return { ...(init ?? {}), signal: controller.signal };
}

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...withDeadline(init as RequestInit | undefined),
          credentials: "include",
        });
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
