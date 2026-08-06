/**
 * Recovers from stale-build asset errors.
 *
 * After a redeploy, an open tab still references the previous build's hashed
 * chunk filenames. Loading a lazy route then fails with
 * "Failed to fetch dynamically imported module", leaving a blank screen.
 * The fix is a single hard reload, which fetches the new index HTML and its
 * current asset hashes. A sessionStorage flag guarantees we never reload loop
 * when the failure is caused by something other than a stale build.
 */
const RELOAD_FLAG = "insightiq:chunk-reload";

function isStaleChunkError(message: string): boolean {
  return (
    message.includes("Failed to fetch dynamically imported module") ||
    message.includes("error loading dynamically imported module") ||
    message.includes("Importing a module script failed") ||
    message.includes("Unable to preload CSS")
  );
}

function reloadOnce(): void {
  try {
    if (sessionStorage.getItem(RELOAD_FLAG)) return;
    sessionStorage.setItem(RELOAD_FLAG, "1");
  } catch {
    // sessionStorage unavailable (private mode) — reload anyway, once per load.
  }
  window.location.reload();
}

/** Registers listeners; returns a cleanup function. Safe to call only client-side. */
export function registerStaleChunkRecovery(): () => void {
  try {
    sessionStorage.removeItem(RELOAD_FLAG);
  } catch {
    /* ignore */
  }

  const onError = (event: Event) => {
    const detail = event as Event & { payload?: { message?: string }; message?: string };
    const message = detail.payload?.message ?? detail.message ?? "";
    if (isStaleChunkError(message)) {
      event.preventDefault?.();
      reloadOnce();
    }
  };

  const onRejection = (event: PromiseRejectionEvent) => {
    const message =
      event.reason instanceof Error ? event.reason.message : String(event.reason ?? "");
    if (isStaleChunkError(message)) {
      event.preventDefault();
      reloadOnce();
    }
  };

  window.addEventListener("vite:preloadError", onError as EventListener);
  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("error", onError as EventListener);

  return () => {
    window.removeEventListener("vite:preloadError", onError as EventListener);
    window.removeEventListener("unhandledrejection", onRejection);
    window.removeEventListener("error", onError as EventListener);
  };
}
