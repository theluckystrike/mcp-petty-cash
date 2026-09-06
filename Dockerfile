# Build context: repository root (monorepo with npm workspaces).
# docker buildx build -f servers/petty-cash/Dockerfile .
#
# The siblings below are copied and built too, because this server is assembled from them:
# mcp-cash-book supplies the chart of accounts (the cash id and the per-category expense
# accounts, imported rather than retyped), mcp-asset-register the money formatting,
# mcp-timezone the corrupt-store quarantine, mcp-quotes the timezone-aware "today". The
# rest are what the cash book itself is built from. Nothing is fetched over the network.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY packages ./packages
COPY servers ./servers
RUN npm install --no-audit --no-fund \
 && npm run build --workspace @theluckystrike/mcp-timezone \
 && npm run build --workspace @theluckystrike/mcp-license \
 && npm run build --workspace @theluckystrike/mcp-invoice \
 && npm run build --workspace @theluckystrike/mcp-billing-docs \
 && npm run build --workspace @theluckystrike/mcp-quotes \
 && npm run build --workspace @theluckystrike/mcp-deposits \
 && npm run build --workspace @theluckystrike/mcp-asset-register \
 && npm run build --workspace @theluckystrike/mcp-statement-of-account \
 && npm run build --workspace @theluckystrike/mcp-cash-book \
 && npm run build --workspace @theluckystrike/mcp-petty-cash

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/servers/timezone/package.json ./servers/timezone/package.json
COPY --from=build /app/servers/timezone/dist ./servers/timezone/dist
COPY --from=build /app/packages/mcp-license/package.json ./packages/mcp-license/package.json
COPY --from=build /app/packages/mcp-license/dist ./packages/mcp-license/dist
COPY --from=build /app/servers/invoice/package.json ./servers/invoice/package.json
COPY --from=build /app/servers/invoice/dist ./servers/invoice/dist
COPY --from=build /app/servers/billing-docs/package.json ./servers/billing-docs/package.json
COPY --from=build /app/servers/billing-docs/dist ./servers/billing-docs/dist
COPY --from=build /app/servers/quotes/package.json ./servers/quotes/package.json
COPY --from=build /app/servers/quotes/dist ./servers/quotes/dist
COPY --from=build /app/servers/deposits/package.json ./servers/deposits/package.json
COPY --from=build /app/servers/deposits/dist ./servers/deposits/dist
COPY --from=build /app/servers/asset-register/package.json ./servers/asset-register/package.json
COPY --from=build /app/servers/asset-register/dist ./servers/asset-register/dist
COPY --from=build /app/servers/asset-register/src/tables ./servers/asset-register/src/tables
COPY --from=build /app/servers/statement-of-account/package.json ./servers/statement-of-account/package.json
COPY --from=build /app/servers/statement-of-account/dist ./servers/statement-of-account/dist
COPY --from=build /app/servers/cash-book/package.json ./servers/cash-book/package.json
COPY --from=build /app/servers/cash-book/dist ./servers/cash-book/dist
COPY --from=build /app/servers/petty-cash/package.json ./servers/petty-cash/package.json
COPY --from=build /app/servers/petty-cash/dist ./servers/petty-cash/dist
RUN npm install --omit=dev --no-audit --no-fund --workspace @theluckystrike/mcp-petty-cash --include-workspace-root=false
CMD ["node", "servers/petty-cash/dist/index.js"]
