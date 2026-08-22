# Always-on mode: real-time websocket instead of 5-minute polling.
#
# Use this on a VPS or your own machine when you want mints caught the second the
# first token is minted, rather than up to 5 minutes later. GitHub Actions cannot
# host this — its jobs are short-lived by design.
#
#   docker build -t mint-sniper .
#   docker run -d --restart=unless-stopped --env-file .env \
#     -v mint-sniper-state:/state mint-sniper
#
# Node 22 rather than 20 because it ships a global WebSocket, which lets stream
# mode run with zero dependencies. On Node 18/20 the code falls back to the `ws`
# package, which this image deliberately does not install.
FROM node:22-alpine

# Run as an unprivileged user. The node image already provides `node` (uid 1000).
WORKDIR /app

# No package manager step at all — the project has no dependencies. Nothing to
# install means nothing to audit and no build cache to invalidate.
COPY --chown=node:node package.json config.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node test ./test

# State lives on a volume so restarts don't replay old alerts. Separate from
# /app so a rebuilt image keeps its memory.
RUN mkdir -p /state && chown node:node /state
VOLUME /state
ENV STATE_FILE=/state/state.json

ENV NODE_ENV=production
ENV MODE=stream

USER node

# Fail the build rather than the deployment if the logic is broken.
RUN node test/selftest.js

# The socket reconnects on its own with exponential backoff, so the process is
# expected to stay up. `--restart=unless-stopped` covers a hard crash.
CMD ["node", "src/index.js"]
