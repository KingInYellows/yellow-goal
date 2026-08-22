# fixture-misleading-readme

100% test coverage. Supports Python 3.8+. Ships with a full async task queue and a Redis-backed
cache layer out of the box.

## Install

```
pip install fixture-misleading-readme
```

Fixture repository: the README makes claims (Python support, test coverage, Redis cache) that the
actual repository contents (a single untested JavaScript file, no Python anywhere) contradict. Used
to exercise `documentation_contradiction` findings.
