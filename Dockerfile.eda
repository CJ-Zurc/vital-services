FROM node:22-bookworm-slim AS build
# API and worker share this runtime target/digest; schemas and migrations stay
# in the separate tools target. Generation uses only maintained Prisma schemas.
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY prisma ./prisma
COPY src/eda ./src/eda
COPY scripts/eda/clean-output.mjs ./scripts/eda/clean-output.mjs
RUN npm run build
COPY docker/eda/runtime.mjs ./docker/eda/runtime.mjs
COPY docker/eda/health.mjs ./docker/eda/health.mjs
COPY test/eda-integration.test.ts ./test/eda-integration.test.ts
COPY test/helpers ./test/helpers

# Administrative/test tooling is a separate, explicitly selected build target.
FROM build AS tools
ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "docker/eda/runtime.mjs"]
CMD ["api"]

FROM build AS production-dependencies
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /etc/ssl/certs /etc/ssl/certs
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/docker/eda/runtime.mjs ./docker/eda/runtime.mjs
COPY --from=build /app/docker/eda/health.mjs ./docker/eda/health.mjs
USER node
ENTRYPOINT ["node", "docker/eda/runtime.mjs"]
CMD ["api"]
