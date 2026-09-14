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
ARG VITE_API_BASE=/api
ARG VITE_CSRF_HEADER=""
ARG VITE_CSRF_COOKIE=""
ARG VITE_REQUEST_ID_HEADER=""
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY --from=build /workspace/dist/ /usr/share/nginx/html/
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
