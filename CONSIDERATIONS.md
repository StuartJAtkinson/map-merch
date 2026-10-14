
- PR #55 "build(deps): update mapbox-earcut requirement from >=2.0.0 to >=2.1.0 in /backend" has no checks: the `CI` workflow (`.github/workflows/ci.yml`) is disabled on GitHub (dispatch → HTTP 422) and the last two main CI runs failed — see `.atelier/views/pr55-ci-disabled.html`. (a) re-enable CI and fix main first, or (b) merge Dependabot PRs unchecked?
