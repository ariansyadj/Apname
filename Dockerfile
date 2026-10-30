# Apname — frontend (VPS mode) untuk Docker
# Build stage: Vite dengan VITE_VPS_MODE=1, supaya frontend memakai
# API + WebSocket satu origin (/api, /ws), bukan Supabase.
# Runtime stage: Nginx melayani dist statis + proxy /api dan /ws
# ke service backend (lihat docker-compose.yml).
# Build: docker compose build web
# File ini TIDAK berisi secret. VITE_* yang dibakar ke build hanya
# penanda mode VPS (bukan kunci), kunci Supabase TIDAK dipakai di
# mode VPS dan TIDAK boleh dimasukkan ke build ini.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_VPS_MODE=1
ENV VITE_VPS_MODE=1
RUN npm run build

FROM nginx:alpine
COPY docker/nginx-web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
