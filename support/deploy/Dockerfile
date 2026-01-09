# syntax=docker/dockerfile:1
#
# db-yard container (Debian “mini” base)
#
# HTTPS + CNAME (example eg.surveilr.com):
# - Point eg.surveilr.com to the host (CNAME or A/AAAA).
# - Terminate TLS in a host reverse proxy (Caddy / NGINX / Traefik).
# - Proxy 443 -> container HTTP port (default 8787). Keep container HTTP-only.

FROM debian:bookworm-slim

# ---- Deno (pinned) -----------------------------------------------------------
ENV DENO_VERSION=2.6.3
ENV DENO_INSTALL=/opt/deno
ENV PATH=/opt/deno/bin:${PATH}

# ---- db-yard defaults --------------------------------------------------------
ENV DB_YARD_VERSION=v0.6.0
ENV DB_YARD_WEB_UI_PORT=8787
ENV DB_YARD_BIN=https://raw.githubusercontent.com/netspective-labs/db-yard/refs/tags/${DB_YARD_VERSION}/bin/yard.ts
ENV DB_YARD_WEB_UI_BIN=https://raw.githubusercontent.com/netspective-labs/db-yard/refs/tags/${DB_YARD_VERSION}/bin/web-ui/serve.ts

# ---- Base deps ---------------------------------------------------------------
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     ca-certificates curl git build-essential procps file unzip xz-utils \
  && rm -rf /var/lib/apt/lists/*

# ---- Install Deno ------------------------------------------------------------
RUN curl -fsSL https://deno.land/install.sh | sh -s "v${DENO_VERSION}"

# ---- Install Homebrew (Linux, latest) ---------------------------------------
# Homebrew installs into /home/linuxbrew/.linuxbrew
ENV HOMEBREW_NO_ANALYTICS=1
ENV HOMEBREW_NO_ENV_HINTS=1
RUN NONINTERACTIVE=1 /bin/bash -lc \
  "curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | bash"

ENV PATH=/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}

# ---- Use brew to install tools ----------------------------------------------
RUN brew update \
  && brew install eget sqlpage

# ---- Install surveilr via eget ----------------------------------------------
# Uses surveilr/packages releases; installs to /usr/local/bin by default
RUN eget surveilr/packages -o /usr/local/bin

# ---- Runtime ----------------------------------------------------------------
WORKDIR /work
VOLUME ["/work/cargo.d"]

EXPOSE 8787

RUN cat > /usr/local/bin/db-yard-entrypoint.sh <<'EOF' \
#!/usr/bin/env sh
set -eu

# Start db-yard (background) directly from tagged URL
deno run -A "${DB_YARD_BIN}" start &

# Allow initialization time
sleep 5

# Start web UI (foreground) directly from tagged URL
exec deno run -A "${DB_YARD_WEB_UI_BIN}" --port "${DB_YARD_WEB_UI_PORT}"
EOF
 && chmod +x /usr/local/bin/db-yard-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/db-yard-entrypoint.sh"]
