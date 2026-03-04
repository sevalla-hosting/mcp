FROM node:24-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
RUN pnpm prune --prod

FROM node:24-alpine

RUN apk add --no-cache libstdc++

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src/ src/

USER node

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "src/index.ts"]
