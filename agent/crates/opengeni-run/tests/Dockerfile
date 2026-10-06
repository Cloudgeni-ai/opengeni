FROM oven/bun:1.4.0 AS bun-runtime
FROM rust:1.82-bookworm AS build
WORKDIR /src/agent
COPY agent .
RUN --mount=type=cache,id=opengeni-run-test-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=opengeni-run-test-target,target=/src/agent/target \
    cargo test --locked -p opengeni-run && \
    cargo build --locked --release -p opengeni-run && \
    install -m 0755 target/release/opengeni-run /usr/local/bin/opengeni-run
RUN cc -O2 -std=c11 -Wall -Wextra -Werror native/command-supervisor/supervisor.c \
    -o /usr/local/bin/opengeni-command-supervisor
RUN cc -O2 -std=c11 -Wall -Wextra -Werror native/command-supervisor/tests/fixture.c \
    -o /usr/local/bin/command-supervisor-fixture
RUN cc -O2 -std=c11 -Wall -Wextra -Werror -shared -fPIC crates/opengeni-run/tests/faults.c \
    -ldl -o /usr/local/lib/opengeni-journal-faults.so
FROM bun-runtime AS conformance
COPY --from=build /usr/local/bin/opengeni-run /usr/local/bin/opengeni-run
COPY --from=build /usr/local/bin/opengeni-command-supervisor /usr/local/bin/opengeni-command-supervisor
COPY --from=build /usr/local/bin/command-supervisor-fixture /usr/local/bin/command-supervisor-fixture
COPY --from=build /usr/local/lib/opengeni-journal-faults.so /usr/local/lib/opengeni-journal-faults.so
COPY agent/crates/opengeni-run/tests/conformance.ts /conformance.ts
CMD ["bun", "/conformance.ts"]
