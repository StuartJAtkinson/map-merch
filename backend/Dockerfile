FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Fonts directory for moat text rendering
COPY fonts/ /app/fonts/

# Create data output directories
RUN mkdir -p /data/svg_output /data/stl_output

ENV PYTHONPATH=/app
ENV DATA_DIR=/data

EXPOSE 8080

CMD ["sh", "-c", "uvicorn app.api.router:app --host 0.0.0.0 --port ${PORT:-8080}"]