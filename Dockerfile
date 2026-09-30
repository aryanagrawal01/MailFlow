# Build the API and worker from the same workspace so their shared packages and
# generated Prisma client are identical.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY backend/package.json backend/package.json
COPY worker/package.json worker/package.json
COPY frontend/package.json frontend/package.json
COPY . .
RUN npm ci \
  && npm run build:shared \
  && npm run build --workspace @mailflow/api \
  && npm run build --workspace @mailflow/worker

# This target runs Prisma migrations. Keep the Prisma CLI available here.
FROM build AS migrate
WORKDIR /app/backend
CMD ["../node_modules/.bin/prisma", "migrate", "deploy", "--config", "prisma.config.ts"]

FROM build AS production-deps
RUN npm prune --omit=dev

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/prisma ./backend/prisma
COPY --from=build /app/backend/prisma.config.ts ./backend/prisma.config.ts
COPY --from=build /app/worker/package.json ./worker/package.json
COPY --from=build /app/worker/dist ./worker/dist
USER node
CMD ["node", "backend/dist/server.js"]
