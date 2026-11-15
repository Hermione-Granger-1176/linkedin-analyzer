# ADR-014: Noise-controlled benchmark gate in CI

**Date:** 2026-11-15 **Status:** Accepted **Deciders:** Aditya Kumar Darak

## Context

`make bench`, `make bench-decode`, and `make bench-browser` measure the analysis pipeline, but only when someone runs them. A change could slow the pipeline and merge without anyone seeing it.

A fixed time budget would not work as a CI gate. Shared runners vary from run to run, so a budget tight enough to catch a regression would also fail unchanged code. Comparing a head run with a separate base run does not solve this either, because the two runs see different machine conditions. While cleaning up the codebase in November 2026, two identical copies of the pipeline timed in one process still differed by up to 12.8% on their medians.

## Decision

- `make bench-compare` times three copies of `web/src` in one Node process: the base commit, an identical copy of it (the control), and the head. Each stage runs once per copy per round, after a forced garbage collection, and the copies take turns going first. The rounds are rounded up to a multiple of three, so every copy runs first, second, and third equally often.
- Each copy is judged by its fastest round. The stages are CPU-bound and run after a collection, so interference only adds time.
- The control's distance from the base is the noise of that run. A stage fails only when the head is slower than the base by more than the threshold (10% by default) plus that noise.
- A flagged stage is timed again with twice the rounds, and the gate fails only when it regresses again. When the total of the gated stages is flagged, every gated stage is timed again.
- Stages shorter than 5 ms are reported but never fail the gate.
- The `web-benchmark` CI job runs the gate on every change to the web area, against the merge base for pull requests and the previous commit for pushes. `scripts/ci/job_gating.py` requires it like every other gated job.
- The gate also compares each stage's output between the base and the head. A difference is reported, not failed, because some changes alter results on purpose. A difference between the base and the control means the harness is broken, and that fails the job.

## Rejected alternatives

- Fixed time budgets. They fail unchanged code on a slow runner and miss regressions on a fast one.
- Medians instead of fastest rounds. On a shared machine, medians of identical copies drifted by 10% or more, which hid a 20% slowdown behind the allowance.
- Ratios taken round by round. The copies change position each round, so a per-round ratio carries that position effect. In one run the measured noise rose to about 10% and hid the same 20% slowdown.
- Running the comparison without a control. The threshold would then have to absorb all of the machine's noise, which makes it either too loose to catch a real regression or tight enough to fail unchanged code.

## Consequences

- A slowdown in the analysis pipeline blocks a pull request, and the job summary shows which stage regressed and by how much.
- The job runs in parallel with the other jobs on web changes. Its first CI run took about one minute, against three for `web-e2e`.
- The gate covers the pipeline in Node only. Browser upload handling, worker startup and messaging, and rendering are not gated. `make bench-browser` still measures those on demand.
- A regression smaller than the threshold plus the measured noise can pass. Lowering the threshold trades sensitivity against the risk of failing on noise.
- All three copies load packages from the head checkout's `node_modules`, so the gate times `web/src` changes, not dependency upgrades. Installing the base's dependencies separately would roughly double the job. A change that removes a package the base still imports leaves the base unable to load, and the gate then skips with a warning rather than failing a valid change.

## Validation

Measured in November 2026 on a shared cloud machine, with the defaults (20 MiB export, 15 rounds, 10% threshold):

- Identical code passed three runs out of three. No stage was flagged, so no confirmation pass ran, and the totals of the gated stages differed from the base by -1.0%, 0.0%, and +0.9%.
- A 16 ms busy wait added to `AnalyticsEngine.compute` (about 77 ms) failed two runs out of two. The stage measured +18.1% and +18.9% against allowances of +10.1% and +11.4%, and the confirmation passes measured +16.1% and +17.8%. No untouched stage was flagged in either run.
- Earlier variants failed on the same slowdown. With medians and no confirmation pass, it also flagged an untouched stage (`insights clean`, +12.7%). With per-round ratios, the measured noise rose to about 10% and the slowdown passed. With medians and a confirmation pass, it passed in two runs out of two.
