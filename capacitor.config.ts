import type { CapacitorConfig } from "@capacitor/cli";

// This app doesn't run a bundled offline copy of the frontend — it points
// the WebView straight at the live Render deployment, the same origin the
// browser version already talks to. That means zero code changes to the
// tRPC client's relative "/api/trpc" URL, and every deploy to Render is
// live in the app immediately with no rebuild/resubmit. The tradeoff: the
// app requires network access on every launch, same as the site does today.
//
// So nothing of the app is packaged: webDir is an empty shell page. It used
// to be dist/public — the whole built app, copied into the APK, where anyone
// with the file could unzip and read it (including, in builds from before
// the roster moved to the server, every classmate's name) although the
// WebView never loads it.
//
// Which deployment: POS_APP_URL when building (each class or year has its
// own Render address), e.g. in PowerShell
//   $env:POS_APP_URL = "https://<your-service>.onrender.com"
// before `cap sync android`. Required, so an APK is never built pointing
// at someone else's shop by accident.
const appUrl = (process.env.POS_APP_URL ?? "").trim().replace(/\/+$/, "");
if (!/^https:\/\/[^/\s]+$/.test(appUrl)) {
  throw new Error(
    "Set POS_APP_URL to your app's address before building the Android app, e.g. https://<your-service>.onrender.com"
  );
}

const config: CapacitorConfig = {
  appId: "com.keikousai.fespos",
  appName: "FES POS",
  webDir: "android-shell",
  server: {
    url: appUrl,
    cleartext: false,
  },
};

export default config;
