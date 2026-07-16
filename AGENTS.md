# Agent instructions — GateLab public release

Read `../AGENTS.md` before editing. This checkout publishes `david-priest/GateLab` and
`https://david-priest.github.io/GateLab/`. It is a **release target**, not the canonical runtime
development repository. Canonical development occurs in the private sibling checkout
`../GateLab` (`david-priest/GateLab-dev`).

## Hard boundary

- Runtime changes under `src/`, shared build configuration, dependencies, and the GateLabR
  submodule must be implemented, tested, and merged in GateLab-dev first.
- Do not independently fix or refactor runtime code here. That creates two plausible versions and
  makes a successful localhost test say nothing about the public application.
- Public-only README content, `docs/` assets, and `.github/workflows/deploy-pages.yml` may be edited
  here through a normal branch/PR.
- Any public change requires David's explicit authorization in the current session.

## Before any edit

```sh
git status --short --branch
git fetch origin
git fetch dev
git log --oneline --max-count=10 origin/master
git log --oneline --max-count=10 dev/master
gh pr list -R david-priest/GateLab
```

Stop if the tree contains unrelated WIP or if another public PR overlaps the change. Branch from
the latest public `origin/master`; never push directly to `master` and never force-push.

## Releasing merged GateLab-dev runtime changes

1. Confirm the corresponding GateLab-dev PR is merged and identify its exact non-merge commits.
2. Create a fresh release branch from public `origin/master` and cherry-pick those commits. The
   dev and public repositories have unrelated histories, so do not merge their branches.
3. Require exact tree parity across the shared application surface:

   ```sh
   git diff --exit-code dev/master HEAD -- \
     src package.json package-lock.json vite.config.ts index.html .gitmodules vendor/GateLabR
   ```

   Do not publish if this reports any difference. Do not overwrite the public-only README, Pages
   workflow, demonstration assets, or this `AGENTS.md` while synchronizing runtime source.
4. Run the public checkout's full validation:

   ```sh
   npm test
   npm run build -- --base=/GateLab/
   ```

5. Inspect the complete public diff, push the release branch, open a PR to public `master`, and
   merge only when the change is exactly the already-reviewed development delta plus any explicit
   public-only release documentation.
6. Watch the Pages workflow to completion and verify the live page serves the new hashed assets.
7. Perform a real deployed-app smoke test. A build, asset HTTP 200, or static screenshot is not
   sufficient. For gate changes, test existing and newly created rectangle, polygon, and quadrant
   gates; after dragging, force another render/population change and verify the gate remains moved.
8. Test with a hard refresh or cache-busting query, then return this checkout to a clean public
   `master` synchronized with `origin/master`.

## Drift diagnosis

When localhost and GitHub Pages behave differently, compare the parity scope first. Assume a
release synchronization omission until parity disproves it. Never paper over drift with a
public-only runtime patch; forward-fix GateLab-dev and release the exact merged commits.
