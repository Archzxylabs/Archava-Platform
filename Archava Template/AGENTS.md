# Working on this template

- This directory must remain standalone after copy or archive extraction. Do not import files from its parent Archava repository.
- Keep the voice/session product independent of chain, wallet, payment-token, and contract code.
- Public project data belongs in `config/project.json`; provider secrets belong only in runtime environment. Personal provider credentials may be stored in the explicitly requested local personal profile, outside template source, and applied to an ignored project `.env` via `setup:personal`. Client setup must start empty. Never include real .env files, user state, deployment links, or credentials in source, client handoffs, or exports.
- Update `prompts/system.md` and verified knowledge together when behavior changes. Planned/unavailable features must remain labelled. An env flag is not release evidence.
- Preserve the strict section/revision protocol, exact guest binding, named dispatch, scoped room metadata, short join grants, and server/worker expiry.
- The four section IDs are a DOM contract. Changing them requires updating components, the config validator, and protocol checks together.
- Run `npm test`, `npm run test:agent`, `npm run build`, and SDK integration tests using the project's Python venv for changes touching session/agent behavior. Live provider calls require project credentials; report when they were not verified.
- Use `npm run export` for handoff. Confirm its source allowlist excludes environment secrets and generated state.
- Template work does not authorize publishing a live service or starting billable provider calls. Prepare concrete deploy files and use credentials only when that deployment/test is explicitly requested.
