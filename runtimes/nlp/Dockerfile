FROM python:3.12-slim AS assets
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MEDCAT_DISABLE_VERSION_CHECK=true AI_ASSET_DIR=/opt/vital-ai-assets BODHI_SOURCE_DIR=/app/vendor/bodhi-s OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 TOKENIZERS_PARALLELISM=false
COPY runtimes/nlp/requirements.lock .
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
COPY runtimes/nlp/app ./app
COPY runtimes/nlp/vendor ./vendor
RUN python -m app.assets.build --source-dir /app/vendor/bodhi-s --output-dir /opt/vital-ai-assets
COPY runtimes/nlp/tests ./runtime-tests
RUN addgroup --system vital && adduser --system --ingroup vital vital && chmod -R a+rX /opt/vital-ai-assets
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
USER vital
RUN VITAL_AI_REAL_MODEL_TESTS=1 python -B -m unittest discover -s runtime-tests -v
EXPOSE 8020
CMD ["python","-m","app.server"]
