FROM grafana/k6:latest

COPY script.js /script.js

ENTRYPOINT ["sh", "-c", "k6 run /script.js; echo 'Load test finished. Sleeping to keep container alive.'; sleep infinity"]
