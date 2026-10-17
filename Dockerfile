FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PROBE_HOST=0.0.0.0
# Committed SDK bundles: no npm install, build tools, secrets or mock gateway entrypoint.
COPY --chown=node:node probe/http.cjs* probe/THIRD_PARTY_NOTICES.txt ./probe/
USER node
CMD ["node", "probe/http.cjs", "--http"]
