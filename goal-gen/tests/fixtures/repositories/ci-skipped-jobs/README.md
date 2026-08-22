# fixture-ci-skipped-jobs

Fixture repository: a CI workflow with a `continue-on-error` (allowed-failure) job and a job
unconditionally skipped via `if: false`. Used to exercise CI-conclusion detection that must not
treat a green summary as sufficient when required jobs were skipped or allowed to fail.
