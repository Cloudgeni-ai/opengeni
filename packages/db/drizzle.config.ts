import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.OPENGENI_DATABASE_URL ?? "postgres://opengeni:opengeni@127.0.0.1:5432/opengeni",
  },
});
