import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.INFRA_AGENT_DATABASE_URL ?? "postgres://infra_agents:infra_agents@127.0.0.1:5432/infra_agents",
  },
});
