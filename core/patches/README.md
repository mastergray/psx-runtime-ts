# Production patches

Only ordered patches required by the selected production core belong here.
Diagnostic or throwaway feasibility patches belong under `core/probes/` and
must never be applied by the release build.

The build applies every numbered patch to the verified clean source checkout,
builds the artifacts, and reverses the patches before returning. Patch names
and contents remain part of the deterministic build identity.
