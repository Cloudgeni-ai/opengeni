#!/usr/bin/env python3
"""Opengeni's protected failure diagnostics for the e2e environment.

Opengeni's API and workers export a closed diagnostic record for each
failure (OPENGENI_OBSERVABILITY_DIAGNOSTICS_ENDPOINT, OTLP logs over HTTP)
instead of logging its causes. This sink, a service on the stack VM, appends
each record, with when it came, to a JSON-lines file the suite copies into
its runs. The
environment holds only synthetic data, so the records may be kept there.

    diagnostics.py ADDRESS PORT FILE
"""

import json
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def records(body):
    for resource in body.get("resourceLogs", []):
        for scope in resource.get("scopeLogs", []):
            for record in scope.get("logRecords", []):
                text = record.get("body", {}).get("stringValue", "")
                try:
                    yield json.loads(text)
                except ValueError:
                    yield {"unparsed": text}


class Sink(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            body = {}
        with open(self.server.path, "a", encoding="utf-8") as out:
            received = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            for record in records(body):
                record["receivedAt"] = received
                out.write(json.dumps(record, separators=(",", ":")) + "\n")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *_):
        pass


def main():
    address, port, path = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    server = ThreadingHTTPServer((address, port), Sink)
    server.path = path
    server.serve_forever()


if __name__ == "__main__":
    main()
