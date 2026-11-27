FROM nginx:1.27-alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/l7zip.conf
COPY site/ /usr/share/nginx/html/
EXPOSE 80
