FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY openapi.json ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV PORT=3000 HOST=0.0.0.0 LIFELINE_DATA_FILE=/app/data/lifeline.json
EXPOSE 3000
CMD ["node", "src/server.js"]
