FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json xlsx-0.20.3.tgz ./
RUN npm ci --omit=dev && npm cache clean --force

COPY app.js ./
COPY src ./src
COPY views ./views
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /app/certs && chown node:node /app/certs

USER node
EXPOSE 3443
CMD ["node", "app.js"]
