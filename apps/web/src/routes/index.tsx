import { createFileRoute } from "@tanstack/react-router";

import { CreateRunForm } from "../components/CreateRunForm";
import { KnownRunsList } from "../components/KnownRunsList";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return (
    <>
      <section className="card">
        <div className="card-header">
          <h2>Start a new run</h2>
        </div>
        <CreateRunForm />
      </section>
      <section className="card">
        <div className="card-header">
          <h2>Recent runs (this browser)</h2>
        </div>
        <KnownRunsList />
      </section>
    </>
  );
}
