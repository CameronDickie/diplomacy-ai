FROM golang:1.23-bookworm AS engine-builder

WORKDIR /src/engine
COPY engine/go.mod engine/go.sum ./
RUN go mod download
COPY engine ./
RUN CGO_ENABLED=0 go build -buildvcs=false -o /out/diplomacy-engine ./cmd/diplomacy-engine

FROM node:22-bookworm-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci

COPY . .
COPY --from=engine-builder /out/diplomacy-engine engine/bin/diplomacy-engine
RUN npm run build -w shared \
  && npm run build -w server \
  && npm run build -w client \
  && npm prune --omit=dev

FROM node:22-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
ENV DIPLOMACY_ENGINE_PATH=/app/engine/bin/diplomacy-engine

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/shared/package.json ./shared/package.json
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/server/package.json ./server/package.json
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/package.json ./client/package.json
COPY --from=builder /app/client/dist ./client/dist
COPY --from=engine-builder /out/diplomacy-engine ./engine/bin/diplomacy-engine
COPY --from=builder /app/LICENSE /app/THIRD_PARTY_NOTICES.md /app/LIBRE_BASKERVILLE_OFL.txt ./
COPY --from=builder /app/package.json /app/package-lock.json /app/tsconfig.base.json /app/Dockerfile ./source/
COPY --from=builder /app/scripts ./source/scripts
COPY --from=builder /app/client/package.json /app/client/index.html /app/client/tsconfig.json /app/client/vite.config.ts ./source/client/
COPY --from=builder /app/client/src ./source/client/src
COPY --from=builder /app/client/public ./source/client/public
COPY --from=builder /app/server/package.json /app/server/tsconfig.json ./source/server/
COPY --from=builder /app/server/src ./source/server/src
COPY --from=builder /app/shared/package.json /app/shared/tsconfig.json ./source/shared/
COPY --from=builder /app/shared/src ./source/shared/src
COPY --from=engine-builder /src/engine ./source/engine
COPY --from=engine-builder /go/pkg/mod/github.com/zond/godip@v0.6.5 ./source/third_party/godip

RUN useradd --create-home --shell /usr/sbin/nologin appuser \
  && chown -R appuser:appuser /app
USER appuser

EXPOSE 3001
CMD ["npm", "start"]
