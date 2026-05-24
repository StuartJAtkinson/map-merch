# Cloud Run Deployment Guide

One-time GCP setup for Heart on a Sleeve. After this is done every push to `main` deploys automatically.

## Prerequisites

- [gcloud CLI](https://cloud.google.com/sdk/docs/install) installed and authenticated (`gcloud auth login`)
- A GCP billing account
- Owner/Editor access on the GCP project you'll create

---

## 1. Create a GCP project

```bash
# Pick a unique project ID (lowercase letters, digits, hyphens, 6-30 chars)
PROJECT_ID=heart-on-a-sleeve-prod

gcloud projects create $PROJECT_ID --name="Heart on a Sleeve"
gcloud config set project $PROJECT_ID
```

Link the project to a billing account in the Cloud Console (Billing section) — Cloud Run and Cloud SQL both require billing enabled.

---

## 2. Enable APIs

```bash
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  sql-component.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  cloudresourcemanager.googleapis.com
```

---

## 3. Create Cloud SQL (PostgreSQL 15 + PostGIS)

```bash
REGION=europe-west2

gcloud sql instances create hoas-db \
  --database-version=POSTGRES_15 \
  --tier=db-f1-micro \
  --region=$REGION \
  --no-backup

gcloud sql databases create heart_on_a_sleeve --instance=hoas-db

# Generate a strong password and save it somewhere safe
DB_PASS=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
echo "DB password: $DB_PASS"

gcloud sql users create heart_user \
  --instance=hoas-db \
  --password="$DB_PASS"
```

### Enable PostGIS and run schema

```bash
gcloud sql connect hoas-db --user=postgres --database=heart_on_a_sleeve
```

In the psql prompt:

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;
GRANT ALL PRIVILEGES ON DATABASE heart_on_a_sleeve TO heart_user;
```

Then paste the contents of `db/init/02-schema.sql` and `\q` to exit.

### Cloud SQL connection string for DATABASE_URL

Cloud Run connects via Unix socket (not TCP):

```
postgresql+asyncpg://heart_user:DB_PASS@/heart_on_a_sleeve?host=/cloudsql/PROJECT_ID:europe-west2:hoas-db
```

Replace `PROJECT_ID` and `DB_PASS`. This goes in GitHub Secrets as `DATABASE_URL` (step 6).

---

## 4. Create a service account for CI/CD

```bash
gcloud iam service-accounts create hoas-deployer \
  --display-name="Heart on a Sleeve Deployer"

SA_EMAIL="hoas-deployer@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/run.admin"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/cloudsql.client"

gcloud iam service-accounts add-iam-policy-binding $SA_EMAIL \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/iam.serviceAccountUser"
```

---

## 5. Set up Workload Identity Federation

Keyless auth — GitHub Actions authenticates to GCP without a stored service account key.

```bash
gcloud iam workload-identity-pools create github-pool \
  --location=global \
  --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github-provider \
  --workload-identity-pool=github-pool \
  --location=global \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='StuartJAtkinson/heart-on-a-sleeve'"

PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format="value(projectNumber)")

gcloud iam service-accounts add-iam-policy-binding $SA_EMAIL \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/attribute.repository/StuartJAtkinson/heart-on-a-sleeve"

# Print the provider resource name — needed for GitHub Secrets in step 6
gcloud iam workload-identity-pools providers describe github-provider \
  --workload-identity-pool=github-pool \
  --location=global \
  --format="value(name)"
```

Output looks like:
```
projects/123456789/locations/global/workloadIdentityPools/github-pool/providers/github-provider
```

---

## 6. Set GitHub secrets and variables

Go to **Settings → Secrets and variables → Actions**.

### Secrets

| Name | Value |
|------|-------|
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | The `projects/.../providers/github-provider` string from step 5 |
| `GCP_SERVICE_ACCOUNT` | `hoas-deployer@PROJECT_ID.iam.gserviceaccount.com` |
| `DATABASE_URL` | `postgresql+asyncpg://heart_user:DB_PASS@/heart_on_a_sleeve?host=/cloudsql/PROJECT_ID:europe-west2:hoas-db` |
| `SECRET_KEY` | `python3 -c "import secrets; print(secrets.token_hex(32))"` |

### Variables

| Name | Value |
|------|-------|
| `GCP_PROJECT_ID` | e.g. `heart-on-a-sleeve-prod` — **setting this activates the deploy job** |
| `GCP_REGION` | `europe-west2` |
| `FRONTEND_URL` | Leave blank for now — set after first deploy (step 7) |

---

## 7. First deploy

Push to `main`. The CI `deploy` job will:

1. Deploy `hoas-backend` to Cloud Run with the Cloud SQL socket attached
2. Deploy `hoas-frontend` with `BACKEND_URL` pointed at the backend
3. Print both service URLs in the "Print URLs" step

After it completes:

1. Copy the **Frontend URL** from the workflow logs
2. Set it as `FRONTEND_URL` in GitHub Variables
3. Push again (or re-run the workflow) — this tightens `CORS_ORIGINS` on the backend from `*` to the actual frontend URL

---

## 8. Verify

```bash
BACKEND=$(gcloud run services describe hoas-backend --region=europe-west2 --format='value(status.url)')
curl $BACKEND/health   # {"status":"ok"}

gcloud run services describe hoas-frontend --region=europe-west2 --format='value(status.url)'
```

---

## Custom domain (optional)

```bash
gcloud run domain-mappings create \
  --service=hoas-frontend \
  --domain=heart.stuartjatkinson.co.uk \
  --region=europe-west2

# Print the DNS records to add at your registrar
gcloud run domain-mappings describe \
  --domain=heart.stuartjatkinson.co.uk \
  --region=europe-west2 \
  --format="value(status.resourceRecords)"
```

After DNS propagates, update `FRONTEND_URL` to `https://heart.stuartjatkinson.co.uk` and push once more.

---

## Notes

**Ephemeral file storage**: Generated SVG/STL files live in the container filesystem and won't survive a container restart or scale-out event. They work fine for single-instance use but migrate `/data/` to Cloud Storage for production durability.

**Cold starts**: Both services use `--min-instances=0` (free when idle). Backend cold start is 5-15 s. Set `--min-instances=1` on the backend if latency matters.

**Database cost**: `db-f1-micro` is approximately £6/month and runs 24/7.

**Overpass endpoint**: Defaults to `https://overpass-api.de/api/interpreter`. Add `OVERPASS_ENDPOINT=https://overpass.kumi.systems/api/interpreter` to the backend `env_vars` in `ci.yml` if the default is slow or rate-limited.
