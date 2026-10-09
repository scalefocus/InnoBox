// InnoBox — Jenkins declarative pipeline: CI (typecheck/lint/test/db-test/build) + gated deploy.
// (INNOBOX_SPEC.md §2.3) Mirrors the GitHub Actions CI workflow and deploys via Docker remote context (no registry).
//
// AGENT PREREQUISITES (label: linux):
//   - asdf with the nodejs plugin (Node 24, from .tool-versions), Docker Engine + the `docker compose` plugin, git, ssh.
//
// JENKINS CREDENTIALS (create these in Jenkins → Credentials, then adjust the IDs):
//   - innobox-deploy-env  : "Secret file"   → the production deploy/.env (secrets; never in git)
//   - innobox-deploy-ssh  : "SSH Username with private key" → access to the deploy host
//   - innobox-deploy-host : "Secret text"   → SSH target for the Docker remote context (user@host)
//   - innobox-deploy-path : "Secret text"   → path to the innobox checkout on the deploy host
//                                             (e.g. /opt/innobox)
//   - innobox-repo-url    : "Secret text"   → https clone URL of the repository
//                                             (e.g. https://<your-git-host>/<group>/InnoBox.git).
//                                             The repository is public, so the deploy host clones
//                                             and fetches anonymously — no git token is needed.
//
// JOB CONFIGURATION: build `main` only. Never discover or build pull requests from forks — this
// agent holds the production credentials and a public repository accepts PRs from anyone. The
// Deploy stage additionally refuses to run on any change-request build (see its `when`).
// Use a Multibranch Pipeline (GitHub branch source) filtered to `main`, with every pull-request
// discovery behaviour removed. Not a plain Pipeline job: it leaves BRANCH_NAME unset, so
// `branch 'main'` never matches and main would not deploy unless DEPLOY were ticked by hand.
//
// Deploy model: Docker remote context over SSH.
//   Jenkins SSHes into the deploy host, clones the repo on first deploy (fast-forwards the
//   checkout to this exact commit afterwards), pushes the secret .env, then runs
//   `docker compose up --build -d` there — images are built and run on the deploy host,
//   no registry required. The public URL comes from PUBLIC_BASE_URL inside that secret .env —
//   no environment-specific value lives in this repository (INNOBOX_SPEC.md §2.3).

pipeline {
  agent { label params.AGENT_LABEL ?: 'linux' }

  options {
    timestamps()
    timeout(time: 60, unit: 'MINUTES')
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '30'))
  }

  parameters {
    string(name: 'AGENT_LABEL', defaultValue: 'linux', description: 'Jenkins agent label to run on')
    booleanParam(name: 'RUN_DB_TESTS', defaultValue: false, description: 'Run gated live-DB integration tests (spins an ephemeral Postgres)')
    booleanParam(name: 'RUN_E2E', defaultValue: false, description: 'Run Playwright browser e2e (spins Postgres + dev server; browsers run in the official Playwright Docker image — no agent provisioning needed)')
    booleanParam(name: 'DEPLOY', defaultValue: false, description: 'Force a deploy from a non-main branch (main deploys automatically; never on pull-request builds)')
    // Deploy target (host + checkout path) comes from Jenkins credentials, not build parameters —
    // see innobox-deploy-host / innobox-deploy-path in the credentials list above.
  }

  environment {
    PNPM_VERSION    = '9.15.9'
    CI_PG_CONTAINER = "innobox-ci-pg-${env.BUILD_TAG}"
    CI_PG_PORT      = '55433'
    // DATABASE_URL used by the gated db-tests (points at the ephemeral CI Postgres).
    CI_DATABASE_URL = "postgres://innobox:test@127.0.0.1:55433/innobox"
    // asdf — must set ASDF_DIR explicitly so asdf.sh can locate itself in a non-interactive shell.
    ASDF_DIR = "${env.HOME}/.asdf"
    PATH     = "${env.HOME}/.asdf/shims:${env.HOME}/.asdf/bin:${env.PATH}"
  }

  stages {
    stage('Toolchain') {
      steps {
        sh '''
          set -eu
          # Activate asdf and install the Node version declared in .tool-versions (Node 24 LTS).
          . "${HOME}/.asdf/asdf.sh"
          asdf plugin add nodejs || true
          asdf install nodejs   # reads .tool-versions; falls back gracefully if already installed
          # Install pnpm via corepack (bundled with Node 16.9+).
          corepack enable
          corepack prepare "pnpm@${PNPM_VERSION}" --activate
          asdf reshim nodejs
          node -v && pnpm -v && docker --context default version --format '{{.Server.Version}}'
        '''
      }
    }

    stage('Install') {
      steps {
        sh '. "${HOME}/.asdf/asdf.sh" && pnpm install --frozen-lockfile'
      }
    }

    stage('Build packages') {
      // shared must build before web/worker can resolve @innobox/shared types.
      steps {
        sh '. "${HOME}/.asdf/asdf.sh" && pnpm -r build'
      }
    }

    stage('Typecheck') {
      steps {
        sh '. "${HOME}/.asdf/asdf.sh" && pnpm -r typecheck'
      }
    }

    stage('Lint') {
      steps {
        sh '. "${HOME}/.asdf/asdf.sh" && pnpm -r lint'
      }
    }

    stage('Unit tests') {
      // Live-DB suites self-skip when INNOBOX_DB_E2E is unset, so this stays hermetic.
      steps {
        sh '. "${HOME}/.asdf/asdf.sh" && pnpm -r test'
      }
    }

    stage('DB integration tests') {
      when { expression { return params.RUN_DB_TESTS } }
      steps {
        sh '''
          set -eu
          . "${HOME}/.asdf/asdf.sh"

          # Ephemeral Postgres for the gated suites.
          docker run -d --rm --name "${CI_PG_CONTAINER}" \
            -e POSTGRES_USER=innobox -e POSTGRES_PASSWORD=test -e POSTGRES_DB=innobox \
            -p ${CI_PG_PORT}:5432 postgres:16-alpine

          # Wait for readiness.
          for i in $(seq 1 30); do
            if docker exec "${CI_PG_CONTAINER}" pg_isready -U innobox >/dev/null 2>&1; then break; fi
            sleep 2
          done

          # The test:db harness creates a fresh throwaway DB per run, applies ALL migrations to
          # it (which creates the innobox_app role), runs the web + worker *.dbtest.ts suites as
          # innobox_app, then drops it — so runs never pollute each other. No psql needed.
          pnpm --filter @innobox/shared build
          TEST_ADMIN_DATABASE_URL="${CI_DATABASE_URL}" \
          TEST_APP_DATABASE_URL="postgres://innobox_app:apptest@127.0.0.1:${CI_PG_PORT}/innobox" \
          TEST_SET_APP_PASSWORD=1 INNOBOX_DB_E2E=1 \
            pnpm test:db
        '''
      }
      post {
        always {
          sh 'docker rm -f "${CI_PG_CONTAINER}" >/dev/null 2>&1 || true'
        }
      }
    }

    stage('E2E (Playwright)') {
      when { expression { return params.RUN_E2E } }
      steps {
        sh '''
          set -eu
          . "${HOME}/.asdf/asdf.sh"
          E2E_PG="innobox-e2e-pg-${BUILD_TAG}"

          # Ephemeral Postgres for the browser e2e; the dev server connects to it.
          docker run -d --rm --name "${E2E_PG}" \
            -e POSTGRES_USER=innobox -e POSTGRES_PASSWORD=test -e POSTGRES_DB=innobox \
            -p ${CI_PG_PORT}:5432 postgres:16-alpine
          for i in $(seq 1 30); do
            if docker exec "${E2E_PG}" pg_isready -U innobox >/dev/null 2>&1; then break; fi
            sleep 2
          done

          pnpm --filter @innobox/shared build
          DATABASE_URL="${CI_DATABASE_URL}" node packages/web/scripts/apply-migrations.mjs

          export DATABASE_URL="${CI_DATABASE_URL}"
          export INNOBOX_DEV_AUTH=1
          export NEXTAUTH_SECRET="e2e-ci-secret-not-used-in-production-0123456789"
          export NEXTAUTH_URL="http://127.0.0.1:3000"
          export E2E_BASE_URL="http://127.0.0.1:3000"
          # The suites submit far more than the per-user rate budgets allow; the dev server reads
          # this to scale them (ignored under NODE_ENV=production).
          export RATE_LIMIT_MULTIPLIER=50

          # Start the dev server on the agent and health-check it before Playwright runs (the
          # config reuses the already-listening server). Kill it on the way out.
          pnpm --filter @innobox/web dev > e2e-web.log 2>&1 &
          WEB_PID=$!
          trap "kill ${WEB_PID} >/dev/null 2>&1 || true" EXIT
          for i in $(seq 1 90); do curl -sf "${E2E_BASE_URL}/api/auth/csrf" >/dev/null && break; sleep 2; done
          curl -sf "${E2E_BASE_URL}/api/auth/csrf" >/dev/null || { echo "dev server did not become ready"; cat e2e-web.log; exit 1; }

          # Run the suite inside the official Playwright image so the agent needs NO Playwright
          # browsers or system libraries — Docker is already an agent prerequisite. The tag is
          # derived from the installed @playwright/test so image browsers always match the driver.
          #   --network host    : the container reaches the dev server on 127.0.0.1:3000
          #   --ipc=host        : Playwright's Chromium recommendation (avoids /dev/shm crashes)
          #   --user            : agent uid/gid, so report/trace files stay owned by the Jenkins user
          #                       (Chromium's user-namespace sandbox can't start for that uid in the
          #                       container, so the config disables it via E2E_NO_SANDBOX — CI-only)
          #   -v PWD:PWD        : same absolute path inside, so pnpm's node_modules symlinks resolve
          #   E2E_NO_WEBSERVER  : the host owns the dev server (started above); the container has no
          #                       pnpm to start one, so the config omits its webServer block and
          #                       fails fast with a clear connection error if the host server died.
          # The test runner itself never touches the DB, so only the base-URL env goes in.
          PW_VERSION="$(node -p "require('./packages/web/node_modules/@playwright/test/package.json').version")"
          docker run --rm --network host --ipc=host \
            --user "$(id -u):$(id -g)" \
            -e HOME=/tmp -e CI=1 -e E2E_NO_SANDBOX=1 -e E2E_NO_WEBSERVER=1 -e E2E_BASE_URL \
            -v "${PWD}:${PWD}" -w "${PWD}/packages/web" \
            "mcr.microsoft.com/playwright:v${PW_VERSION}-noble" \
            ./node_modules/.bin/playwright test -c e2e/playwright.config.ts \
            || { echo "=== dev server log (e2e-web.log) ==="; cat e2e-web.log; exit 1; }
        '''
      }
      post {
        always {
          sh 'docker rm -f "innobox-e2e-pg-${BUILD_TAG}" >/dev/null 2>&1 || true'
          // Kept even when the build is aborted (where the in-step `cat` never runs).
          archiveArtifacts artifacts: 'packages/web/playwright-report/**, e2e-web.log', allowEmptyArchive: true
        }
      }
    }

    stage('Deploy') {
      when {
        allOf {
          // Never deploy a change request (PR) build, whatever the parameter says.
          not { changeRequest() }
          anyOf {
            branch 'main'
            expression { return params.DEPLOY }
          }
        }
      }
      steps {
        // A missing credential fails the build here with a clear "credentials not found" error,
        // so no explicit DEPLOY_HOST validation is needed anymore.
        withCredentials([
          file(credentialsId: 'innobox-deploy-env', variable: 'DEPLOY_ENV_FILE'),
          sshUserPrivateKey(credentialsId: 'innobox-deploy-ssh', keyFileVariable: 'SSH_KEY', usernameVariable: 'SSH_USER'),
          string(credentialsId: 'innobox-deploy-host', variable: 'DEPLOY_HOST'),
          string(credentialsId: 'innobox-deploy-path', variable: 'DEPLOY_PATH'),
          string(credentialsId: 'innobox-repo-url', variable: 'REPO_URL')
        ]) {
          sh '''
            set -eu
            SSH="ssh -i ${SSH_KEY} -o StrictHostKeyChecking=accept-new"
            SCP="scp -i ${SSH_KEY} -o StrictHostKeyChecking=accept-new"

            # ── 1. Clone on first deploy, then fast-forward to this exact commit ──────────
            # REPO_URL comes from the innobox-repo-url credential (with or without the https://
            # prefix — it is normalized here). The repository is public: clone and fetch are
            # anonymous, so no token reaches the deploy host.
            # origin is re-pointed on every run, so a checkout cloned from an earlier remote
            # follows the credential. Never re-clone to switch remotes — see clean -x below.
            # checkout --force + clean -fd make the tree byte-exact to the commit: local edits
            # to tracked files are discarded and untracked leftovers from earlier runs removed.
            # Deliberately NOT clean -x: gitignored paths must survive — deploy/.env (secrets)
            # and deploy/data/** (postgres/minio/clamav volumes) live inside the checkout.
            REPO_HOSTPATH="${REPO_URL#https://}"
            REPO_CLEAN_URL="https://${REPO_HOSTPATH}"
            $SSH "${DEPLOY_HOST}" "if [ ! -d ${DEPLOY_PATH}/.git ]; then git clone ${REPO_CLEAN_URL} ${DEPLOY_PATH}; fi && cd ${DEPLOY_PATH} && git remote set-url origin ${REPO_CLEAN_URL} && git fetch origin --prune && git checkout --force --detach ${GIT_COMMIT} && git clean -fd"

            # ── 2. Push the secret .env to the deploy host (never in git) ─────────────────
            # Remove-then-copy: a stale .env owned by another user (e.g. root after manual
            # debugging on the host) fails the overwrite with EACCES, but unlinking only needs
            # write on the directory, which the deploy user has. chmod 600 keeps secrets tight.
            # CRs are stripped in transit: a secret file saved on Windows has CRLF endings, which
            # compose tolerates but `. ./.env` (step 4) does not — every value would carry a
            # trailing \\r (e.g. an "invalid" bucket name). Piped, so no extra copy hits disk.
            $SSH "${DEPLOY_HOST}" "rm -f ${DEPLOY_PATH}/deploy/.env"
            tr -d '\\r' < "${DEPLOY_ENV_FILE}" | $SSH "${DEPLOY_HOST}" "umask 077 && cat > ${DEPLOY_PATH}/deploy/.env"
            $SSH "${DEPLOY_HOST}" "chmod 600 ${DEPLOY_PATH}/deploy/.env"

            # ── 3. Build images and (re)start the stack on the remote host ─────────────────
            $SSH "${DEPLOY_HOST}" "cd ${DEPLOY_PATH}/deploy && docker compose up --build -d"

            # ── 4. Ensure the MinIO attachment bucket exists (idempotent) ──────────────────
            # mc mb -p is a no-op when the bucket already exists, so any failure here is real
            # (MinIO down, bad credentials) and must fail the deploy: /readyz checks only the
            # database, so a missing bucket would otherwise ship silently and break every
            # upload. MinIO may still be starting right after `compose up`, hence the retry.
            cat > /tmp/_innobox_minio.sh << 'MINIO_SCRIPT'
#!/bin/sh
cd __DEPLOY_PATH__/deploy || exit 1
set -a; . ./.env; set +a
for i in $(seq 1 20); do
  if docker compose exec -T -e S3_BUCKET="${S3_BUCKET:-innobox-attachments}" minio sh -c 'mc alias set s3 http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" && mc mb -p s3/${S3_BUCKET:-innobox-attachments}'; then
    exit 0
  fi
  sleep 3
done
echo "MinIO bucket could not be ensured" >&2
exit 1
MINIO_SCRIPT
            sed -i "s|__DEPLOY_PATH__|${DEPLOY_PATH}|g" /tmp/_innobox_minio.sh
            $SCP /tmp/_innobox_minio.sh "${DEPLOY_HOST}:/tmp/_innobox_minio.sh"
            rm -f /tmp/_innobox_minio.sh
            $SSH "${DEPLOY_HOST}" 'rc=0; sh /tmp/_innobox_minio.sh || rc=$?; rm -f /tmp/_innobox_minio.sh; exit $rc'

            # ── 5. Smoke-check readiness ──────────────────────────────────────────────────
            # Exits non-zero when every attempt fails, so a stack that never becomes ready
            # fails the pipeline instead of going green. On failure it dumps container state and
            # the web/proxy log tails, so the build log carries the cause (a 502 means the proxy
            # cannot reach web at all — typically web crash-looping on a startup check).
            $SSH "${DEPLOY_HOST}" 'for i in $(seq 1 30); do curl -fsS http://localhost:8080/readyz && exit 0; sleep 3; done; echo "readyz never became ready" >&2; cd '"${DEPLOY_PATH}"'/deploy || exit 1; docker compose ps -a; docker compose logs --no-color --tail 100 web proxy; exit 1'

            # ── 6. Housekeeping: drop docker residue from this and earlier builds ──────────
            # image prune -f removes only DANGLING images (the <none> layers each --build
            # supersedes, plus leftovers of previously failed builds); builder prune trims the
            # BuildKit cache LRU-style but keeps the newest 8g so rebuilds stay fast. Neither
            # touches volumes, bind-mounted data, or any tagged/running image. Best-effort:
            # housekeeping must never fail a deploy that is already live.
            $SSH "${DEPLOY_HOST}" "docker image prune -f && docker builder prune -f --keep-storage 8g" || true
          '''
        }
      }
    }
  }

  post {
    always {
      sh 'docker rm -f "${CI_PG_CONTAINER}" >/dev/null 2>&1 || true'
    }
    success { echo "innobox pipeline OK — ${env.GIT_COMMIT}" }
    failure { echo "innobox pipeline FAILED — ${env.GIT_COMMIT}" }
  }
}

// ── Notes ─────────────────────────────────────────────────────────────────────────────────────
//  - Docker remote context (current): Jenkins connects to the deploy host via SSH and runs
//    `docker compose up --build -d` there. No registry needed; images are built on the target.
//  - Registry-based upgrade path: tag + push images in a "Push images" stage, add `image:` fields
//    to docker-compose.yml, and replace the compose call with `docker compose pull && up -d`.
//  - Secrets: deploy/.env must NEVER be committed; injected via the `innobox-deploy-env` credential.
//    The dev-auth bypass env flag must never be set in production (INNOBOX_SPEC.md §2.3).
