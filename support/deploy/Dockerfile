# syntax=docker/dockerfile:1
#
# db-yard container (Debian “mini” base)
#
# Public HTTPS + CNAME notes (example eg.surveilr.com):
# - DNS: create a CNAME eg.surveilr.com -> your public host name (or A/AAAA to the server IP).
# - TLS: terminate HTTPS at the edge using a reverse proxy (Caddy, NGINX, Traefik, etc.).
# - Proxy: forward 443 -> container HTTP port (default 8787). Keep the container HTTP-only.
#
# Example (conceptual Caddy config on host):
#   eg.surveilr.com {
#     reverse_proxy 127.0.0.1:8787
#   }

FROM debian:bookworm-slim

# Pin Deno for reproducibility
ENV DENO_VERSION=1.40.5
ENV DENO_INSTALL=/opt/deno
ENV PATH=/opt/deno/bin:${PATH}

# db-yard defaults (override with `-e` at runtime if desired)
ENV DB_YARD_VERSION=v0.6.0
ENV DB_YARD_BIN=https://raw.githubusercontent.com/netspective-labs/db-yard/refs/tags/${DB_YARD_VERSION}/bin/yard.ts
ENV DB_YARD_WEB_UI_PORT=8787
ENV DB_YARD_WEB_UI_BIN=https://raw.githubusercontent.com/netspective-labs/db-yard/refs/tags/${DB_YARD_VERSION}/bin/web-ui/serve.ts

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*

# Install the pinned Deno version
RUN curl -fsSL https://deno.land/install.sh | sh -s "v${DENO_VERSION}"

# Runtime expects /work/cargo.d to be mounted and ready.
# `yard.ts start` is responsible for creating /work/ledger.d.
WORKDIR /work
VOLUME ["/work/cargo.d"]

EXPOSE 8787

RUN cat > /usr/local/bin/db-yard-entrypoint.sh <<'EOF' \
#!/usr/bin/env sh
set -eu

# Start db-yard (background) from the tagged URL
deno run -A "${DB_YARD_BIN}" start &

# Allow initialization time
sleep 5

# Start web UI (foreground) from the tagged URL
exec deno run -A "${DB_YARD_WEB_UI_BIN}" --port "${DB_YARD_WEB_UI_PORT}"
EOF
 && chmod +x /usr/local/bin/db-yard-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/db-yard-entrypoint.sh"]
