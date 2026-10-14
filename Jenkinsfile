// InnoBox — Jenkins declarative pipeline: CI (build libs → typecheck, then web build | lint |
// unit | db-test | e2e in parallel) + gated deploy.
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
    // 120, not 60: the browser e2e (~93 specs against a dev server) ran well past an hour on the
    // agent and was cut off mid-suite. Two shards + route warm-up should bring it far under that;
    // the headroom stays so a slow agent fails on a real error, not the clock.
    timeout(time: 120, unit: 'MINUTES')
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '30'))
  }

  parameters {
    string(name: 'AGENT_LABEL', defaultValue: 'linux', description: 'Jenkins agent label to run on')
    booleanParam(name: 'RUN_DB_TESTS', defaultValue: false, description: 'Run gated live-DB integration tests (spins an ephemeral Postgres)')
    // The first choice is the default.
    choice(name: 'E2E_MODE', choices: ['QUICK_E2E_TESTS', 'NO_E2E_TESTS', 'FULL_E2E_TESTS'], description: 'Playwright browser e2e (spins Postgres + dev server; browsers run in the official Playwright Docker image — no agent provisioning needed). NO_E2E_TESTS = skip it. QUICK_E2E_TESTS = a fresh random 10% of the e2e tests on every build, in a single shard (E2E_SHARDS is ignored); the picked tests are listed in the log and archived as e2e-quick.txt. FULL_E2E_TESTS = the whole suite, split into E2E_SHARDS shards.')
    string(name: 'E2E_SHARDS', defaultValue: '2', description: 'FULL_E2E_TESTS only: split the e2e suite into this many shards (1-9), run in parallel on this agent as separate Playwright containers against ONE shared Postgres + web dev server; 1 = the whole suite in one container. Specs that change platform-wide settings always stay together in shard 1. More shards = more concurrent browsers sharing the agent\'s CPU and RAM and the one dev server.')
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
    // The e2e gets its own Postgres on its own port: it runs in parallel with the db-tests.
    CI_E2E_PG_CONTAINER = "innobox-e2e-pg-${env.BUILD_TAG}"
    CI_E2E_PG_PORT      = '55434'
    CI_E2E_DATABASE_URL = "postgres://innobox:test@127.0.0.1:55434/innobox"
    CI_E2E_PW_CONTAINER = "innobox-e2e-pw-${env.BUILD_TAG}"
    // V8 heap cap (MB) for the e2e dev server. Uncapped, a long run grew it until the kernel OOM
    // killer SIGKILLed it — no log line, and the starved agent dropped its Jenkins connection.
    // Capped, V8 collects harder and, if it truly runs out, dies with a readable "heap limit"
    // error. Tune to the agent's RAM.
    CI_E2E_WEB_HEAP_MB  = '4096'
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

    stage('Build libs') {
      // Only the tsc packages: every later stage resolves @innobox/shared through its dist/, and
      // the worker build must not race the worker unit tests (both write worker/dist). pnpm runs
      // the filtered builds in topological order, so shared builds before worker. The slow Next
      // build of web runs later, in parallel with the tests.
      steps {
        sh '. "${HOME}/.asdf/asdf.sh" && pnpm --filter @innobox/shared --filter @innobox/worker build'
      }
    }

    stage('Typecheck') {
      // Deliberately NOT in the parallel block: web's typecheck generates next-env.d.ts (untracked;
      // `next typegen`) and tsc reads it, while `next dev` (E2E) and `next build` (Build web) both
      // rewrite it as they start — dev points it at .next/dev/types, build at .next/types. Running
      // it here, before either starts, keeps it deterministic. Needs only shared's dist/, which
      // Build libs produced.
      steps {
        sh '. "${HOME}/.asdf/asdf.sh" && pnpm -r typecheck'
      }
    }

    // Everything below is independent, so it runs side by side on the same agent:
    //   - Build web is `next build`; Next 16 keeps `next dev` output in .next/dev, so it can run
    //     while the E2E dev server is up.
    //   - Lint needs no build output (every ESLint config ignores dist/ and .next/).
    //   - Unit tests are hermetic (live-DB suites self-skip without INNOBOX_DB_E2E). Shared's
    //     `test` tsc is incremental (no re-emit after Build libs); worker's re-emits worker/dist,
    //     which no other branch reads (the DB suites run the worker from src via tsx).
    //   - DB integration and E2E each get their OWN ephemeral Postgres on a distinct host port
    //     (CI_PG_PORT / CI_E2E_PG_PORT), so they never share a database or collide on a bind.
    // failFast false: a red branch never aborts the others, so one build reports every check.
    stage('Checks & tests') {
      failFast false
      parallel {
        stage('Build web') {
          steps {
            sh '. "${HOME}/.asdf/asdf.sh" && pnpm --filter @innobox/web build'
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
          // QUICK_E2E_TESTS or FULL_E2E_TESTS. Unset on the first build after the parameter is
          // added, which counts as NO_E2E_TESTS.
          when { expression { return (params.E2E_MODE ?: 'NO_E2E_TESTS') != 'NO_E2E_TESTS' } }
          steps {
            sh '''
              set -eu
              . "${HOME}/.asdf/asdf.sh"

              # The E2E_MODE build parameter (validated up front, before anything is started).
              #   FULL_E2E_TESTS  : the whole suite in E2E_SHARDS shards (the fallback covers the
              #                     first build after that parameter is added, when it isn't defined).
              #   QUICK_E2E_TESTS : a random 10% of the tests, picked now by scripts/e2e-specs.mjs as
              #                     Playwright test locations (e2e/<file>.spec.ts:<line>), run as
              #                     shard 1 of 1 narrowed to those locations; E2E_SHARDS is ignored.
              #                     The pick is logged and archived, so a failing quick run can be
              #                     rerun locally with the same tests.
              QUICK_ARGS=""
              rm -f e2e-quick.txt   # never archive a previous build's pick
              case "${E2E_MODE}" in
                QUICK_E2E_TESTS)
                  SHARDS=1
                  node packages/web/scripts/e2e-specs.mjs quick > e2e-quick.txt
                  [ -s e2e-quick.txt ] || { echo "the quick e2e picked no tests"; exit 1; }
                  cat e2e-quick.txt
                  QUICK_ARGS="$(cat e2e-quick.txt)"
                  ;;
                FULL_E2E_TESTS)
                  SHARDS="${E2E_SHARDS:-2}"
                  case "${SHARDS}" in
                    [1-9]) ;;
                    *) echo "E2E_SHARDS must be a whole number from 1 to 9, got '${SHARDS}'"; exit 1 ;;
                  esac
                  ;;
                *) echo "E2E_MODE must be QUICK_E2E_TESTS or FULL_E2E_TESTS here, got '${E2E_MODE}'"; exit 1 ;;
              esac

              # Ephemeral Postgres for the browser e2e; the dev server connects to it.
              docker run -d --rm --name "${CI_E2E_PG_CONTAINER}" \
                -e POSTGRES_USER=innobox -e POSTGRES_PASSWORD=test -e POSTGRES_DB=innobox \
                -p ${CI_E2E_PG_PORT}:5432 postgres:16-alpine
              for i in $(seq 1 30); do
                if docker exec "${CI_E2E_PG_CONTAINER}" pg_isready -U innobox >/dev/null 2>&1; then break; fi
                sleep 2
              done

              DATABASE_URL="${CI_E2E_DATABASE_URL}" node packages/web/scripts/apply-migrations.mjs

              export DATABASE_URL="${CI_E2E_DATABASE_URL}"
              export INNOBOX_DEV_AUTH=1
              export NEXTAUTH_SECRET="e2e-ci-secret-not-used-in-production-0123456789"
              export NEXTAUTH_URL="http://127.0.0.1:3000"
              # The CSRF Origin check accepts only PUBLIC_BASE_URL's origin (NEXTAUTH_URL is never a
              # fallback). Unset, dev falls back to Next's own request origin — which it reports as
              # localhost — so every mutation from the 127.0.0.1 browser would be refused with a 403.
              export PUBLIC_BASE_URL="http://127.0.0.1:3000"
              export E2E_BASE_URL="http://127.0.0.1:3000"
              # The suites submit far more than the per-user rate budgets allow; the dev server reads
              # this to scale them (ignored under NODE_ENV=production).
              export RATE_LIMIT_MULTIPLIER=50
              # A throwaway AI key so the AI provider e2e drives the full configure → test → save →
              # enable flow against its local provider stub (never a real provider).
              export AI_TOKEN_ENC_KEY="$(openssl rand -base64 32)"
              # The public submission e2e switches the form on, which needs an intake key and an
              # e-mail transport. The SMTP fallback below is configured but never reached — no
              # worker runs here, so nothing is sent; the test reads the confirmation token through
              # the dev seam instead.
              export PUBLIC_INTAKE_KEY="$(openssl rand -base64 32)"
              export SMTP_HOST="127.0.0.1"
              export SMTP_FROM="innobox-e2e@example.invalid"

              # Start the dev server on the agent and health-check it before Playwright runs (the
              # config reuses the already-listening server). Kill it on the way out.
              #   NODE_OPTIONS  : the V8 heap cap (CI_E2E_WEB_HEAP_MB, see environment)
              #   E2E_KEEP_ROUTES_COMPILED : next.config.ts keeps compiled routes resident instead
              #                   of disposing them after 60 s idle (a dev-only setting)
              #   setsid        : its own process group, so cleanup also kills next's child
              #                   processes, not just the pnpm wrapper
              #   WEB_EXIT      : gets the server's exit status when it dies — the watchdog polls it
              #                   (a dead child can linger as a zombie, which `kill -0` still finds)
              WEB_EXIT="${PWD}/e2e-web.exit"
              rm -f "${WEB_EXIT}" "${PWD}"/e2e-shard-*.exit
              export E2E_KEEP_ROUTES_COMPILED=1
              NODE_OPTIONS="--max-old-space-size=${CI_E2E_WEB_HEAP_MB}" \
                setsid sh -c 'pnpm --filter @innobox/web dev > e2e-web.log 2>&1; echo $? > "$0"' "${WEB_EXIT}" &
              WEB_PID=$!
              # Removes every shard's Playwright container (they're named ${CI_E2E_PW_CONTAINER}-N).
              stop_shards() {
                docker ps -aq --filter "name=${CI_E2E_PW_CONTAINER}-" | xargs -r docker rm -f >/dev/null 2>&1 || true
              }
              trap 'kill -TERM -"${WEB_PID}" >/dev/null 2>&1 || kill "${WEB_PID}" >/dev/null 2>&1 || true; stop_shards' EXIT
              for i in $(seq 1 90); do curl -sf "${E2E_BASE_URL}/api/auth/csrf" >/dev/null && break; sleep 2; done
              curl -sf "${E2E_BASE_URL}/api/auth/csrf" >/dev/null || { echo "dev server did not become ready"; cat e2e-web.log; exit 1; }

              # Compile every page and API route now, so no spec waits on a cold compile — or has its
              # page fully reloaded by Fast Refresh when a compile lands mid-test.
              node packages/web/scripts/e2e-warmup.mjs || { echo "=== dev server log (e2e-web.log) ==="; cat e2e-web.log; exit 1; }

              # Run the suite inside the official Playwright image so the agent needs NO Playwright
              # browsers or system libraries — Docker is already an agent prerequisite. The tag is
              # derived from the installed @playwright/test so image browsers always match the driver.
              #
              # E2E_SHARDS SHARDS AT ONCE, all against the one dev server + database above (Next allows
              # one `next dev` per checkout, and more servers would multiply the memory). E2E_SHARD=i +
              # E2E_SHARD_TOTAL=n make the config pick its slice: specs that change platform-wide
              # state all stay in shard 1, the rest are balanced by test count (see
              # e2e/playwright.config.ts). Each shard writes its own test-results/ and
              # playwright-report/ subfolder; its output lines are prefixed [shard i]. They run in the
              # background so the watchdog below can stop them.
              #   --name            : so the watchdog and cleanup can stop the container
              #   --network host    : the container reaches the dev server on 127.0.0.1:3000
              #   --ipc=host        : Playwright's Chromium recommendation (avoids /dev/shm crashes)
              #   --user            : agent uid/gid, so report/trace files stay owned by the Jenkins user
              #                       (Chromium's user-namespace sandbox can't start for that uid in the
              #                       container, so the config disables it via E2E_NO_SANDBOX — CI-only)
              #   -v PWD:PWD        : same absolute path inside, so pnpm's node_modules symlinks resolve
              #   E2E_NO_WEBSERVER  : the host owns the dev server (started above); the container has no
              #                       pnpm to start one, so the config omits its webServer block and
              #                       fails fast with a clear connection error if the host server died.
              #   QUICK_ARGS        : the quick run's picked test locations (empty on a full run)
              # The test runner itself never touches the DB, so only the base-URL env goes in.
              PW_VERSION="$(node -p "require('./packages/web/node_modules/@playwright/test/package.json').version")"
              run_shard() {
                {
                  rc=0
                  docker run --rm --name "${CI_E2E_PW_CONTAINER}-$1" --network host --ipc=host \
                    --user "$(id -u):$(id -g)" \
                    -e HOME=/tmp -e CI=1 -e E2E_NO_SANDBOX=1 -e E2E_NO_WEBSERVER=1 -e E2E_BASE_URL \
                    -e E2E_SHARD="$1" -e E2E_SHARD_TOTAL="${SHARDS}" \
                    -v "${PWD}:${PWD}" -w "${PWD}/packages/web" \
                    "mcr.microsoft.com/playwright:v${PW_VERSION}-noble" \
                    ./node_modules/.bin/playwright test -c e2e/playwright.config.ts ${QUICK_ARGS} || rc=$?
                  # (QUICK_ARGS is unquoted on purpose: one argument per picked location.)
                  echo "${rc}" > "${PWD}/e2e-shard-$1.exit"
                } 2>&1 | sed -u "s/^/[shard $1] /"
              }
              if [ -n "${QUICK_ARGS}" ]; then
                echo "=== running the quick e2e: $(wc -l < e2e-quick.txt) randomly picked test(s), in 1 shard ==="
              else
                echo "=== running the e2e in ${SHARDS} shard(s) ==="
              fi
              SHARD_PIDS=""
              for n in $(seq 1 "${SHARDS}"); do
                run_shard "${n}" &
                SHARD_PIDS="${SHARD_PIDS} $!"
              done

              # How many shards have written their exit status so far.
              shards_done() { ls e2e-shard-*.exit 2>/dev/null | wc -l; }

              # Watchdog: if the dev server dies mid-suite, stop every shard at once and say so,
              # rather than letting every remaining spec fail on "connection refused".
              SERVER_DIED=0
              while [ "$(shards_done)" -lt "${SHARDS}" ]; do
                if [ "${SERVER_DIED}" = 0 ] && [ -f "${WEB_EXIT}" ]; then
                  SERVER_DIED=1
                  echo "=== the dev server exited mid-suite (status $(cat "${WEB_EXIT}")) — stopping Playwright ==="
                  stop_shards
                fi
                sleep 5
              done
              # shellcheck disable=SC2086 # word-splitting the PID list is intended
              wait ${SHARD_PIDS} || true

              FAILED_SHARDS=""
              for n in $(seq 1 "${SHARDS}"); do
                rc="$(cat "e2e-shard-${n}.exit")"
                echo "=== shard ${n} exit: ${rc} ==="
                [ "${rc}" = 0 ] || FAILED_SHARDS="${FAILED_SHARDS} ${n}"
              done

              if [ "${SERVER_DIED}" = 1 ] || [ -n "${FAILED_SHARDS}" ]; then
                [ -z "${FAILED_SHARDS}" ] || echo "=== failed shard(s):${FAILED_SHARDS} ==="
                echo "=== dev server log (e2e-web.log) ==="
                cat e2e-web.log
                if [ "${SERVER_DIED}" = 1 ]; then
                  # No "heap limit" error in the log above + a SIGKILL status (137) = killed from
                  # outside, most likely the kernel OOM killer (dmesg may be unreadable for this user).
                  echo "=== kernel OOM-killer messages (if readable) ==="
                  dmesg -T 2>/dev/null | grep -iE 'killed process|out of memory' | tail -n 5 || true
                fi
                exit 1
              fi
            '''
          }
          post {
            always {
              sh '''
                docker rm -f "${CI_E2E_PG_CONTAINER}" >/dev/null 2>&1 || true
                docker ps -aq --filter "name=${CI_E2E_PW_CONTAINER}-" | xargs -r docker rm -f >/dev/null 2>&1 || true
              '''
              // Kept even when the build is aborted (where the in-step `cat` never runs).
              archiveArtifacts artifacts: 'packages/web/playwright-report/**, e2e-web.log, e2e-quick.txt', allowEmptyArchive: true
            }
          }
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
      sh '''
        docker rm -f "${CI_PG_CONTAINER}" "${CI_E2E_PG_CONTAINER}" >/dev/null 2>&1 || true
        docker ps -aq --filter "name=${CI_E2E_PW_CONTAINER}-" | xargs -r docker rm -f >/dev/null 2>&1 || true
      '''
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
