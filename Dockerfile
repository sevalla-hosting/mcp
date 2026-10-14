FROM node:26-alpine AS builder

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
RUN npm install --global "$(node -p "require('./package.json').packageManager")" && pnpm install --frozen-lockfile --prod

FROM node:26-alpine

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src/ src/

USER node

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "src/index.ts"]
