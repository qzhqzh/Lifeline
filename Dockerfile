FROM node:22-alpine AS web-builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY scripts ./scripts
COPY public ./public
COPY test ./test
RUN npm run build:test-map

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY --from=web-builder /app/public ./public
COPY openapi.json ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV PORT=3000 HOST=0.0.0.0 LIFELINE_DATA_FILE=/app/data/lifeline.json
EXPOSE 3000
CMD ["node", "src/server.js"]
