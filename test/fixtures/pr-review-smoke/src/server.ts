import { Hono } from "hono";

const app = new Hono();

app.get("/preview", async (context) => {
  const target = context.req.query("target");
  if (!target) return context.json({ error: "target is required" }, 400);

  const response = await fetch(target);
  return context.body(await response.text(), response.status as 200);
});

app.post("/deploy/:environment", async (context) => {
  const environment = context.req.param("environment");
  const request = await context.req.json<{ image: string }>();

  await fetch(`https://deployments.internal/environments/${environment}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });

  return context.json({ accepted: true }, 202);
});

export default app;
