FROM node:22-slim

# --- Python + uv (mcp-geo, spawned via uvx by unified-server.js) ---
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && curl -LsSf https://astral.sh/uv/install.sh | sh \
  && ln -s /root/.local/bin/uv /usr/local/bin/uv \
  && ln -s /root/.local/bin/uvx /usr/local/bin/uvx

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY unified-server.js bridge.js ./

# Pre-fetch both child servers so first-request latency is low.
RUN uvx --with 'mcp<2' --from mcp-geo python -c "print('mcp-geo prefetched')" || true

ENV PORT=8080
CMD ["node", "bridge.js"]
