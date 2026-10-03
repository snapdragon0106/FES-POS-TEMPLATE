// Loads DATABASE_URL from .env for local drizzle-kit commands (studio,
// generate, migrate). dotenv does not override variables that are already
// set, so hosted environments like Render keep using their own config.
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to run drizzle commands");
}

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle",
  dialect: "mysql",
  dbCredentials: {
    url: connectionString,
  },
});
