# Deploying to Cloud Run

One-time setup (~15 minutes). After this, every `git push` to `main` deploys automatically.

---

## Prerequisites

- `gcloud` CLI installed and logged in (`gcloud auth login`)
- A GCP project created (`gcloud projects create heart-on-a-sleeve-YOURNAME`)
- Billing enabled on the project

```bash
export PROJECT_ID=heart-on-a-sleeve-YOURNAME   # change this
export REGION=europe-west2                      # London — change if you prefer
gcloud config set project $PROJECT_ID
```

---

## Step 1 — Enable APIs

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com
```

---

## Step 2 — Create a deployer service account

```bash
gcloud iam service-accounts create hoas-deployer \
  --display-name "Heart on a Sleeve deployer"

# Grant only what Cloud Run deploy needs
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:hoas-deployer@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/run.developer"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:hoas-deployer@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"
```

---

## Step 3 — Workload Identity Federation (no stored key)

This lets GitHub Actions authenticate as the service account using a short-lived OIDC token.
No JSON key file is ever created or stored.

```bash
# Create the pool
gcloud iam workload-identity-pools create github-pool \
  --location=global \
  --display-name="GitHub Actions pool"

# Create the OIDC provider
gcloud iam workload-identity-pools providers create-oidc github-provider \
  --location=global \
  --workload-identity-pool=github-pool \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --display-name="GitHub OIDC"

# Allow your specific repo to impersonate the deployer SA
gcloud iam service-accounts add-iam-policy-binding \
  hoas-deployer@${PROJECT_ID}.iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')/locations/global/workloadIdentityPools/github-pool/attribute.repository/StuartJAtkinson/heart-on-a-sleeve"

# Print the provider resource name — you'll need this below
gcloud iam workload-identity-pools providers describe github-provider \
  --workload-identity-pool=github-pool \
  --location=global \
  --format="value(name)"
```

---

## Step 4 — Set GitHub repo secrets and variables

Go to **GitHub → Settings → Secrets and variables → Actions**.

**Variables** (not secret — visible in logs):

| Name | Value |
|---|---|
| `GCP_PROJECT_ID` | your project ID e.g. `heart-on-a-sleeve-123456` |
| `GCP_REGION` | `europe-west2` |

**Secrets** (hidden in logs):

| Name | Value |
|---|---|
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | output of the `gcloud … describe` command above |
| `GCP_SERVICE_ACCOUNT` | `hoas-deployer@PROJECT_ID.iam.gserviceaccount.com` |
| `DATABASE_URL` | `postgresql+asyncpg://user:pass@host/dbname` — use [Neon](https://neon.tech) free tier |
| `SECRET_KEY` | random string: `python -c "import secrets; print(secrets.token_hex(32))"` |

---

## Step 5 — First deploy

```bash
git commit --allow-empty -m "trigger first deploy"
git push
```

Watch it in GitHub → Actions. The `deploy` job was previously skipped (no `GCP_PROJECT_ID`);
now it will run and create the Cloud Run services automatically.

---

## After first deploy

The frontend Cloud Run URL needs to be told about the backend URL.
Update the nginx proxy in `frontend/nginx.conf` if the backend URL is not the default.

Cloud Run services scale to **zero instances** when idle (no traffic = no cost).
Typical cost for light use: **< $1/month**.

---

## Database — Neon (recommended for testing)

1. Create a free account at neon.tech
2. Create a project → copy the connection string
3. It looks like: `postgresql://user:pass@ep-name.region.aws.neon.tech/dbname?sslmode=require`
4. Change scheme to asyncpg for FastAPI: `postgresql+asyncpg://user:pass@...`
5. Paste as `DATABASE_URL` secret in GitHub

Neon is serverless Postgres — scales to zero, free tier is generous, works identically
on Cloud Run, your homelab, or any other host.
