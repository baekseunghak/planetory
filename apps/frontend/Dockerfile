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
ARG VITE_OAUTH_SSAFY_URL=/oauth2/authorization/ssafy
ARG VITE_OAUTH_GOOGLE_URL=/oauth2/authorization/google
ARG VITE_NICKNAME_REQUIRED_CODE=""
ARG VITE_INITIAL_NICKNAME_PATH=""
ARG VITE_SKY_RENDERER_ENABLED=false
RUN npm run build
# 렌더러를 켠 빌드에만 표식을 남긴다. 배포 헬스 확인이 이 경로를 본다.
# 플래그가 빠진 채 빌드되면 표식이 없어 헬스가 실패하고 직전 이미지로 돌아간다.
# 번들 내부 문자열이 아니라 빌드 인자에서 만들므로 청크 이름이 바뀌어도 깨지지 않는다.
RUN if [ "$VITE_SKY_RENDERER_ENABLED" = "true" ]; then \
      mkdir -p dist/health && echo ok > dist/health/renderer-enabled; \
    fi

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY --from=build /workspace/dist/ /usr/share/nginx/html/
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
