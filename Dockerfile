# node:22 ships the built-in node:sqlite module (needs Node >= 22.5), so the
# app runs the same everywhere regardless of the host's Node version.
FROM node:22-alpine

WORKDIR /app

# Install production deps first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (data/ and uploads/ are provided as volumes at runtime).
COPY server ./server
COPY public ./public
COPY scripts ./scripts

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server/index.js"]
