# Pinned to the nginx 1.30 stable branch: rebuilds still get its patch releases,
# but a new stable branch is only adopted by bumping this line on purpose.
FROM nginx:1.30-alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
COPY nginx.conf /etc/nginx/conf.d/l7zip.conf
COPY site/ /usr/share/nginx/html/
EXPOSE 80
