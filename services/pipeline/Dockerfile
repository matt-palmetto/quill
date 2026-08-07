# node:22-alpine, digest-pinned via `docker buildx imagetools inspect node:22-alpine`
# (2026-08-06, alpine 3.24, linux/amd64+arm64 multi-arch index).
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

RUN addgroup -g 10001 -S quill && adduser -u 10001 -S quill -G quill

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY sources.json ./sources.json

RUN chown -R quill:quill /app
USER 10001

CMD ["node", "src/run.mjs", "ingest"]
