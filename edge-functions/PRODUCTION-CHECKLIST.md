# Production acceptance checks (do not skip)

- [ ] Rotate all credentials exposed in the previous ZIP / source or history. Confirm no active bearer tokens in files or commits.
- [ ] OAuth S2S client belongs to Edge Delivery Services API integration; technical-account email has DA ACL access at the exact source paths.
- [ ] With the same S2S credential: DA list 200, test JSON Source POST 201, Source GET 200 and DELETE 204, on a disposable file.
- [ ] `config/edgeFunctions.yaml` and `config/cdn.yaml` contain correct hostname and repo values, not example.com placeholders.
- [ ] STAGE and MAIN Cloud Manager secret variables have been added, and shared EDS config pipeline succeeded.
- [ ] Scope sets match the actual Stage/Main credentials; no JWT pasted as `x-api-key`.
- [ ] `npm test` and `npm run check` pass. Validate Adobe CLI build and Stage deploy in an environment with the installed CLI.
- [ ] Stage health, dry-run and all allowed DA operations tested with cleanup under `data/testing/`.
- [ ] Internal API only: WAF / allowlisted callers / TLS / upstream rate limiting / logging controls are applied.
- [ ] Sheet mutation concurrency/race behavior reviewed. If multiple updates per asset are expected, develop idempotent per-asset event processing before production.
- [ ] DA permissions are least-privilege; backup/recovery strategy for sheet deletion and move has been approved.
- [ ] Main deployment approved; no read-only 200 is treated as write proof.
