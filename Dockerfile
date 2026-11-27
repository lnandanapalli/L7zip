# stable-alpine: each rebuild picks up the latest patched nginx stable release
FROM nginx:stable-alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
COPY nginx.conf /etc/nginx/conf.d/l7zip.conf
COPY site/ /usr/share/nginx/html/
EXPOSE 80
