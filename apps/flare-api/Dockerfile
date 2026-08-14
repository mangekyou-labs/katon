FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps apps
COPY packages packages
RUN npm ci --ignore-scripts

COPY . .
ENV FLARE_API_PORT=8787
EXPOSE 8787
CMD ["npm", "run", "dev:flare-api"]
