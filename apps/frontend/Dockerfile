# syntax=docker/dockerfile:1

FROM node:22-alpine AS dependencies
WORKDIR /workspace

COPY apps/frontend/package.json apps/frontend/package-lock.json ./
RUN npm ci

FROM dependencies AS development
COPY apps/frontend/ ./
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

FROM dependencies AS build
COPY apps/frontend/ ./
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY --from=build /workspace/dist/ /usr/share/nginx/html/

EXPOSE 8080
