FROM node:20-alpine AS build
WORKDIR /app
COPY cesium/package.json cesium/package-lock.json* ./
RUN npm ci --prefer-offline
COPY cesium/ .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
# Stored as a template; envsubst fills in ${BACKEND_URL} at container start.
COPY nginx.conf /etc/nginx/templates/default.conf.template
EXPOSE 80
# Only substitute ${BACKEND_URL} — leave nginx variables ($host, $uri, etc.) intact.
CMD ["/bin/sh", "-c", "envsubst '$BACKEND_URL' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'"]
